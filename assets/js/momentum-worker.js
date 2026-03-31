/**
 * Momentum Screener – Web Worker  (v6)
 *
 * Architecture: PHP parses Excel once (cached as JSON transient).
 * The main thread fetches that JSON and sends the raw row arrays here.
 * No SheetJS, no importScripts, no fetch inside the worker.
 *
 * Message protocol:
 *   IN  { type:'init', pricesRaw:[...], dividendsRaw:[...]|null }
 *   IN  { type:'recalculate', settings:{...}, id:<number> }
 *   OUT { type:'ready', stats:{ n, m, activeTickers, tickers } }
 *   OUT { type:'result', id, portfolioValues, detailedTrades,
 *               currentRecommendations, metrics, tipMetrics }
 *   OUT { type:'error', message:'...' }
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
var tickersCache      = null;
var n = 0, m = 0;
var hasDivs           = false;
var dataReady         = false;

var pricesByTicker    = {};
var validRunByTicker  = {};
var returnPrefixSum   = {};
var returnPrefixSumSq = {};
var divPrefixByTicker = {};
var dates             = [];

var momentumMatrix = null;
var phase1CacheKey = null;

// ════════════════════════════════════════════════════════════════════════════
// Date helper – Excel serial number → Date object
// ════════════════════════════════════════════════════════════════════════════

function parseExcelDate(val) {
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
        // Excel serial: days since 1899-12-30 (accounts for 1900 leap-year bug)
        return new Date(Math.round((val - 25569) * 86400000));
    }
    return new Date(val);
}

// ════════════════════════════════════════════════════════════════════════════
// buildIndexes – raw row-object arrays → typed-array structures
// Called once after receiving 'init'.  pricesRaw / dividendsRaw are GC'd after.
// ════════════════════════════════════════════════════════════════════════════

function buildIndexes(pricesRaw, dividendsRaw) {
    // Date array
    dates = new Array(n);
    for (var i = 0; i < n; i++) {
        dates[i] = parseExcelDate(pricesRaw[i].Time);
    }

    for (var ti = 0; ti < m; ti++) {
        var ticker = tickersCache[ti];

        // ── Price array ────────────────────────────────────────────────────
        var prices = new Float64Array(n);
        for (var i = 0; i < n; i++) {
            var v = pricesRaw[i][ticker];
            prices[i] = (v != null && v > 0) ? v : NaN;
        }
        pricesByTicker[ticker] = prices;

        // ── Consecutive-valid-price count (O(1) continuity check) ──────────
        var run = new Uint16Array(n);
        run[0] = isNaN(prices[0]) ? 0 : 1;
        for (var i = 1; i < n; i++) {
            run[i] = isNaN(prices[i]) ? 0 : Math.min(run[i - 1] + 1, 65535);
        }
        validRunByTicker[ticker] = run;

        // ── Return prefix sums (O(1) volatility) ───────────────────────────
        var pSum  = new Float64Array(n);
        var pSumS = new Float64Array(n);
        for (var i = 1; i < n; i++) {
            var p0 = prices[i - 1], p1 = prices[i];
            if (!isNaN(p0) && !isNaN(p1) && p0 > 0) {
                var r  = (p1 - p0) / p0;
                pSum[i]  = pSum[i - 1] + r;
                pSumS[i] = pSumS[i - 1] + r * r;
            } else {
                pSum[i]  = pSum[i - 1];
                pSumS[i] = pSumS[i - 1];
            }
        }
        returnPrefixSum[ticker]   = pSum;
        returnPrefixSumSq[ticker] = pSumS;

        // ── Dividend prefix sums (O(1) range sum) ──────────────────────────
        var dPrefix = new Float64Array(n + 1);
        if (dividendsRaw) {
            var dLen = dividendsRaw.length;
            for (var i = 0; i < n && i < dLen; i++) {
                var row = dividendsRaw[i];
                dPrefix[i + 1] = dPrefix[i] + ((row && row[ticker]) ? row[ticker] : 0);
            }
            // Fill remaining if dividend data is shorter than price data
            for (var i = dLen; i < n; i++) {
                dPrefix[i + 1] = dPrefix[i];
            }
        }
        divPrefixByTicker[ticker] = dPrefix;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

/** O(1) volatility — std-dev of weekly returns over [start+1 .. end] × 100. */
function calcVolFast(ticker, start, end) {
    var count = end - start;
    if (count < 2) return 0;
    var pSum  = returnPrefixSum[ticker];
    var pSumS = returnPrefixSumSq[ticker];
    var sumR  = pSum[end]  - pSum[start];
    var sumR2 = pSumS[end] - pSumS[start];
    var mean  = sumR / count;
    return Math.sqrt(Math.max(0, sumR2 / count - mean * mean)) * 100;
}

/** O(1) dividend sum for rows [from, to] inclusive. */
function getDivSum(ticker, from, to) {
    var f = Math.max(0, from);
    var t = Math.min(to, n - 1);
    if (f > t) return 0;
    var p = divPrefixByTicker[ticker];
    return p[t + 1] - p[f];
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 1 – precompute sorted momentum scores for every week  O(n·m)
// Result is cached; only recomputed when the 6 Phase-1 parameters change.
// ════════════════════════════════════════════════════════════════════════════

function getPhase1Key(s) {
    return [s.lookbackPeriod, s.skipWeeks, s.useDividends,
            s.useVolFilter, s.maxVol, s.useRiskAdj].join('|');
}

function precomputeMomentumMatrix(settings) {
    var lb       = settings.lookbackPeriod;
    var skip     = settings.skipWeeks;
    var startMin = lb + skip;
    var matrix   = new Array(n).fill(null);

    for (var i = startMin; i < n; i++) {
        var scores = [];

        for (var ti = 0; ti < m; ti++) {
            var ticker = tickersCache[ti];
            var prices = pricesByTicker[ticker];
            var curP   = prices[i];
            if (isNaN(curP)) continue;

            var pastIdx = i - lb - skip;
            if (pastIdx < 0) continue;
            var pastP = prices[pastIdx];
            if (isNaN(pastP)) continue;

            // O(1) continuity check
            var volStart   = Math.max(0, pastIdx);
            var windowSize = i - volStart + 1;
            if (validRunByTicker[ticker][i] < windowSize) continue;

            // O(1) volatility
            var vol = calcVolFast(ticker, volStart, i);
            if (settings.useVolFilter && vol > settings.maxVol) continue;

            var priceReturn = (curP - pastP) / pastP;
            var totalReturn = priceReturn;

            if (settings.useDividends && hasDivs) {
                var divStart = pastIdx + 1;
                var divEnd   = skip > 0 ? i - skip : i;
                totalReturn  = priceReturn + getDivSum(ticker, divStart, divEnd) / pastP;
            }

            var momentum = totalReturn;
            if (settings.useRiskAdj && vol > 0) {
                momentum = (totalReturn * 100) / vol;
            }

            scores.push({ ticker: ticker, momentum: momentum, price: curP,
                          volatility: vol, rawReturn: totalReturn });
        }

        scores.sort(function(a, b) { return b.momentum - a.momentum; });
        matrix[i] = scores;
    }

    return matrix;
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 2 – build portfolio from cached momentum matrix
// ════════════════════════════════════════════════════════════════════════════

function buildPortfolio(settings) {
    var startIdx = settings.lookbackPeriod + settings.skipWeeks;
    var holdPer  = settings.holdingPeriod;
    var topN     = settings.topN;
    var useRetF  = settings.useReturnFilter;
    var minRet   = settings.minReturn;
    var maxRet   = settings.maxReturn;
    var useDiv   = settings.useDividends && hasDivs;

    if (startIdx >= n - holdPer) {
        return { error: 'Недостаточно данных для расчёта. Попробуйте уменьшить период расчёта momentum.' };
    }

    var portfolioValues = [];
    var detailedTrades  = [];
    var cash = 100000;

    for (var i = startIdx; i < n - holdPer; i += holdPer) {
        var allScores = momentumMatrix[i];
        if (!allScores || allScores.length === 0) continue;

        if (useRetF) {
            allScores = allScores.filter(function(s) {
                var rp = s.rawReturn * 100;
                return rp >= minRet && rp <= maxRet;
            });
        }

        var selected = allScores.slice(0, topN);
        if (selected.length === 0) continue;

        var periodReturn = 0;
        var stockDetails = [];

        for (var si = 0; si < selected.length; si++) {
            var stock    = selected[si];
            var buyPrice = stock.price;
            var sellPrice = pricesByTicker[stock.ticker][i + holdPer];
            if (isNaN(sellPrice) || sellPrice <= 0) continue;

            var prRet = (sellPrice - buyPrice) / buyPrice;
            var stRet = useDiv
                ? prRet + getDivSum(stock.ticker, i + 1, i + holdPer) / buyPrice
                : prRet;

            periodReturn += stRet / selected.length;
            stockDetails.push({
                ticker:    stock.ticker,
                momentum:  stock.momentum,
                buyPrice:  buyPrice.toFixed(2),
                sellPrice: sellPrice.toFixed(2),
                return:    (stRet * 100).toFixed(2),
                weight:    (100 / selected.length).toFixed(1)
            });
        }

        cash *= (1 + periodReturn);
        portfolioValues.push({ date: formatDate(dates[i]), value: cash, return: periodReturn * 100 });
        detailedTrades.push({
            date:        formatDate(dates[i]),
            sellDate:    formatDate(dates[i + holdPer]),
            totalReturn: (periodReturn * 100).toFixed(2),
            stockCount:  selected.length,
            stocks:      stockDetails
        });
    }

    if (portfolioValues.length === 0) {
        return { error: 'Недостаточно данных для расчёта' };
    }

    // ── Current recommendations ───────────────────────────────────────────────
    var lastIdx = n - 1;
    var currentRecommendations = null;
    if (lastIdx >= startIdx && momentumMatrix[lastIdx]) {
        var recScores = momentumMatrix[lastIdx];
        if (useRetF) {
            recScores = recScores.filter(function(s) {
                var rp = s.rawReturn * 100;
                return rp >= minRet && rp <= maxRet;
            });
        }
        var sel = recScores.slice(0, topN);
        currentRecommendations = {
            date:          formatDate(dates[lastIdx]),
            portfolioSize: sel.length,
            stocks: sel.map(function(s, idx) {
                return {
                    ticker:     s.ticker,
                    price:      s.price.toFixed(2),
                    momentum:   (s.momentum * 100).toFixed(2),
                    rawReturn:  (s.rawReturn * 100).toFixed(2),
                    volatility: s.volatility.toFixed(2),
                    weight:     (100 / topN).toFixed(1),
                    rank:       idx + 1
                };
            })
        };
    }

    // ── Metrics ──────────────────────────────────────────────────────────────
    var totalReturn  = ((cash - 100000) / 100000) * 100;
    var firstPVDate  = new Date(portfolioValues[0].date);
    var lastPVDate   = new Date(portfolioValues[portfolioValues.length - 1].date);
    var totalYears   = (lastPVDate - firstPVDate) / (1000 * 60 * 60 * 24 * 365.25);
    var annualReturn = totalYears > 0 ? (Math.pow(cash / 100000, 1 / totalYears) - 1) * 100 : 0;

    var periods        = portfolioValues.length;
    var periodsPerYear = 52 / holdPer;
    var avgReturn = portfolioValues.reduce(function(s, v) { return s + v.return; }, 0) / periods;
    var volatility = Math.sqrt(
        portfolioValues.reduce(function(s, v) { return s + Math.pow(v.return - avgReturn, 2); }, 0) / periods
    );

    var annualAvg   = avgReturn * periodsPerYear;
    var annualVol   = volatility * Math.sqrt(periodsPerYear);
    var sharpeRatio = annualVol > 0 ? annualAvg / annualVol : 0;

    var dsR = portfolioValues.filter(function(v) { return v.return < avgReturn; }).map(function(v) { return v.return; });
    var downVol = Math.sqrt(
        dsR.reduce(function(s, r) { return s + Math.pow(r - avgReturn, 2); }, 0) / periods
    );
    var annualDVol   = downVol * Math.sqrt(periodsPerYear);
    var sortinoRatio = annualDVol > 0 ? annualAvg / annualDVol : sharpeRatio;

    var peak = portfolioValues[0].value, maxDrawdown = 0;
    for (var vi = 0; vi < portfolioValues.length; vi++) {
        var v = portfolioValues[vi];
        if (v.value > peak) peak = v.value;
        var dd = ((v.value - peak) / peak) * 100;
        if (dd < maxDrawdown) maxDrawdown = dd;
    }

    return {
        portfolioValues: portfolioValues,
        detailedTrades:  detailedTrades,
        currentRecommendations: currentRecommendations,
        metrics: {
            totalReturn:  totalReturn.toFixed(2),
            annualReturn: annualReturn.toFixed(2),
            avgReturn:    avgReturn.toFixed(2),
            volatility:   volatility.toFixed(2),
            sharpeRatio:  sharpeRatio.toFixed(2),
            sortinoRatio: sortinoRatio.toFixed(2),
            maxDrawdown:  maxDrawdown.toFixed(2),
            trades: detailedTrades.length,
            years:  totalYears.toFixed(1)
        },
        tipMetrics: { sharpeRatio: sharpeRatio, sortinoRatio: sortinoRatio,
                      maxDrawdown: maxDrawdown, annualReturn: annualReturn }
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

function runBacktest(settings) {
    var key = getPhase1Key(settings);
    if (key !== phase1CacheKey) {
        momentumMatrix = precomputeMomentumMatrix(settings);
        phase1CacheKey = key;
    }
    return buildPortfolio(settings);
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function(e) {
    var type = e.data.type;

    if (type === 'init') {
        var pricesRaw    = e.data.pricesRaw;
        var dividendsRaw = e.data.dividendsRaw || null;

        try {
            if (!pricesRaw || pricesRaw.length === 0) {
                throw new Error('Данные цен отсутствуют');
            }

            tickersCache = Object.keys(pricesRaw[0]).filter(function(k) { return k !== 'Time'; });
            n       = pricesRaw.length;
            m       = tickersCache.length;
            hasDivs = !!(dividendsRaw && dividendsRaw.length > 0);

            buildIndexes(pricesRaw, dividendsRaw);

            // Reset phase-1 cache
            momentumMatrix = null;
            phase1CacheKey = null;
            dataReady      = true;

            var lastRow     = pricesRaw[n - 1];
            var activeCount = tickersCache.filter(function(t) {
                return lastRow[t] != null && lastRow[t] > 0;
            }).length;

            self.postMessage({
                type:  'ready',
                stats: { n: n, m: m, activeTickers: activeCount, tickers: tickersCache }
            });

        } catch (err) {
            self.postMessage({
                type:    'error',
                message: 'Ошибка инициализации: ' + err.message
            });
        }

    } else if (type === 'recalculate') {
        if (!dataReady) {
            // Shouldn't happen if main thread respects workerReady flag, but guard anyway
            self.postMessage({ type: 'error', message: 'Данные ещё не загружены' });
            return;
        }

        try {
            var result = runBacktest(e.data.settings);
            self.postMessage({ type: 'result', id: e.data.id,
                portfolioValues:        result.portfolioValues,
                detailedTrades:         result.detailedTrades,
                currentRecommendations: result.currentRecommendations,
                metrics:                result.metrics,
                tipMetrics:             result.tipMetrics,
                error:                  result.error || null
            });
        } catch (err) {
            // Surface the real error instead of letting the worker die silently
            self.postMessage({
                type:    'error',
                message: 'Ошибка расчёта: ' + err.message +
                         (err.stack ? '\n' + err.stack.split('\n').slice(0, 3).join('\n') : '')
            });
        }
    }
};
