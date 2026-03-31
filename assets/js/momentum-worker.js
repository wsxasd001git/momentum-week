/**
 * Momentum Screener – Web Worker  (v5)
 *
 * The worker owns the entire data pipeline:
 *   1. Receives excelUrl + sheetjsUrl in 'init' message
 *   2. importScripts(sheetjsUrl)  — loads XLSX library once (cached)
 *   3. fetch(excelUrl)            — downloads the Excel file
 *   4. XLSX.read(...)             — parses it (no cellDates → fast)
 *   5. buildIndexes()             — builds typed-array structures
 *   6. postMessage 'ready' + stats back to main thread
 *
 * The main thread is never blocked by data work.
 * All subsequent 'recalculate' messages only carry a lightweight settings object.
 */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
let tickersCache = null;
let n = 0;
let m = 0;
let hasDivs = false;

let pricesByTicker    = {};
let validRunByTicker  = {};
let returnPrefixSum   = {};
let returnPrefixSumSq = {};
let divPrefixByTicker = {};
let dates             = [];

let momentumMatrix = null;
let phase1CacheKey = null;

// ════════════════════════════════════════════════════════════════════════════
// Date helper — handles both Excel serial numbers and date strings
// ════════════════════════════════════════════════════════════════════════════

function parseExcelDate(val) {
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
        // Excel serial date: days since 1900-01-00 (with 1900 leap-year bug)
        return new Date(Math.round((val - 25569) * 86400000));
    }
    return new Date(val);
}

// ════════════════════════════════════════════════════════════════════════════
// buildIndexes — converts row-oriented JS objects to typed arrays
// Called once after parsing. Raw priceData/dividendData are local and
// will be GC'd after this returns.
// ════════════════════════════════════════════════════════════════════════════

function buildIndexes(priceData, dividendData) {
    // Date array
    dates = new Array(n);
    for (let i = 0; i < n; i++) {
        dates[i] = parseExcelDate(priceData[i].Time);
    }

    for (let ti = 0; ti < m; ti++) {
        const ticker = tickersCache[ti];

        // ── Price array ────────────────────────────────────────────────────
        const prices = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const v = priceData[i][ticker];
            prices[i] = (v && v > 0) ? v : NaN;
        }
        pricesByTicker[ticker] = prices;

        // ── Consecutive-valid-price count (O(1) continuity check) ──────────
        const run = new Uint16Array(n);
        run[0] = isNaN(prices[0]) ? 0 : 1;
        for (let i = 1; i < n; i++) {
            run[i] = isNaN(prices[i]) ? 0 : Math.min(run[i - 1] + 1, 65535);
        }
        validRunByTicker[ticker] = run;

        // ── Return prefix sums (O(1) volatility) ───────────────────────────
        const pSum  = new Float64Array(n);
        const pSumS = new Float64Array(n);
        for (let i = 1; i < n; i++) {
            const p0 = prices[i - 1], p1 = prices[i];
            if (!isNaN(p0) && !isNaN(p1) && p0 > 0) {
                const r = (p1 - p0) / p0;
                pSum[i]  = pSum[i - 1] + r;
                pSumS[i] = pSumS[i - 1] + r * r;
            } else {
                pSum[i]  = pSum[i - 1];
                pSumS[i] = pSumS[i - 1];
            }
        }
        returnPrefixSum[ticker]   = pSum;
        returnPrefixSumSq[ticker] = pSumS;

        // ── Dividend prefix sums (O(1) div sum for any range) ──────────────
        const dPrefix = new Float64Array(n + 1);
        if (dividendData) {
            for (let i = 0; i < n && i < dividendData.length; i++) {
                const row = dividendData[i];
                dPrefix[i + 1] = dPrefix[i] + ((row && row[ticker]) ? row[ticker] : 0);
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

/** O(1) volatility — std-dev of returns over [start+1 .. end] × 100. */
function calcVolFast(ticker, start, end) {
    const count = end - start;
    if (count < 2) return 0;
    const pSum  = returnPrefixSum[ticker];
    const pSumS = returnPrefixSumSq[ticker];
    const sumR  = pSum[end]  - pSum[start];
    const sumR2 = pSumS[end] - pSumS[start];
    const mean  = sumR / count;
    return Math.sqrt(Math.max(0, sumR2 / count - mean * mean)) * 100;
}

/** O(1) dividend sum for rows [from, to] inclusive. */
function getDivSum(ticker, from, to) {
    const f = Math.max(0, from);
    const t = Math.min(to, n - 1);
    if (f > t) return 0;
    const p = divPrefixByTicker[ticker];
    return p[t + 1] - p[f];
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 1 – precompute sorted momentum scores for every week  O(n·m)
// ════════════════════════════════════════════════════════════════════════════

function getPhase1Key(s) {
    return [s.lookbackPeriod, s.skipWeeks, s.useDividends,
            s.useVolFilter, s.maxVol, s.useRiskAdj].join('|');
}

function precomputeMomentumMatrix(settings) {
    const lb       = settings.lookbackPeriod;
    const skip     = settings.skipWeeks;
    const startMin = lb + skip;
    const matrix   = new Array(n).fill(null);

    for (let i = startMin; i < n; i++) {
        const scores = [];

        for (const ticker of tickersCache) {
            const prices  = pricesByTicker[ticker];
            const curP    = prices[i];
            if (isNaN(curP)) continue;

            const pastIdx = i - lb - skip;
            if (pastIdx < 0) continue;
            const pastP   = prices[pastIdx];
            if (isNaN(pastP)) continue;

            // O(1) continuity check
            const volStart   = Math.max(0, pastIdx);
            const windowSize = i - volStart + 1;
            if (validRunByTicker[ticker][i] < windowSize) continue;

            // O(1) volatility
            const vol = calcVolFast(ticker, volStart, i);
            if (settings.useVolFilter && vol > settings.maxVol) continue;

            const priceReturn = (curP - pastP) / pastP;
            let totalReturn   = priceReturn;

            if (settings.useDividends && hasDivs) {
                const divStart = pastIdx + 1;
                const divEnd   = skip > 0 ? i - skip : i;
                totalReturn    = priceReturn + getDivSum(ticker, divStart, divEnd) / pastP;
            }

            let momentum = totalReturn;
            if (settings.useRiskAdj && vol > 0) {
                momentum = (totalReturn * 100) / vol;
            }

            scores.push({ ticker, momentum, price: curP, volatility: vol, rawReturn: totalReturn });
        }

        scores.sort((a, b) => b.momentum - a.momentum);
        matrix[i] = scores;
    }

    return matrix;
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 2 – build portfolio from cached momentum matrix
// ════════════════════════════════════════════════════════════════════════════

function buildPortfolio(settings) {
    const startIdx = settings.lookbackPeriod + settings.skipWeeks;
    const holdPer  = settings.holdingPeriod;
    const topN     = settings.topN;
    const useRetF  = settings.useReturnFilter;
    const minRet   = settings.minReturn;
    const maxRet   = settings.maxReturn;
    const useDiv   = settings.useDividends && hasDivs;

    if (startIdx >= n - holdPer) {
        return { error: 'Недостаточно данных для расчета. Попробуйте уменьшить период расчета momentum.' };
    }

    const portfolioValues = [];
    const detailedTrades  = [];
    let cash = 100000;

    for (let i = startIdx; i < n - holdPer; i += holdPer) {
        let allScores = momentumMatrix[i];
        if (!allScores || allScores.length === 0) continue;

        if (useRetF) {
            allScores = allScores.filter(s => {
                const rp = s.rawReturn * 100;
                return rp >= minRet && rp <= maxRet;
            });
        }

        const selected = allScores.slice(0, topN);
        if (selected.length === 0) continue;

        let periodReturn = 0;
        const stockDetails = [];

        for (const stock of selected) {
            const buyPrice  = stock.price;
            const sellPrice = pricesByTicker[stock.ticker][i + holdPer];
            if (isNaN(sellPrice) || sellPrice <= 0) continue;

            const prRet = (sellPrice - buyPrice) / buyPrice;
            const stRet = useDiv
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
        return { error: 'Недостаточно данных для расчета' };
    }

    // Current recommendations
    const lastIdx = n - 1;
    let currentRecommendations = null;
    if (lastIdx >= startIdx && momentumMatrix[lastIdx]) {
        let recScores = momentumMatrix[lastIdx];
        if (useRetF) {
            recScores = recScores.filter(s => {
                const rp = s.rawReturn * 100;
                return rp >= minRet && rp <= maxRet;
            });
        }
        const sel = recScores.slice(0, topN);
        currentRecommendations = {
            date:          formatDate(dates[lastIdx]),
            stocks:        sel.map((s, idx) => ({
                ticker:     s.ticker,
                price:      s.price.toFixed(2),
                momentum:   (s.momentum * 100).toFixed(2),
                rawReturn:  (s.rawReturn * 100).toFixed(2),
                volatility: s.volatility.toFixed(2),
                weight:     (100 / topN).toFixed(1),
                rank:       idx + 1
            })),
            portfolioSize: sel.length
        };
    }

    // ── Metrics ──────────────────────────────────────────────────────────────
    const totalReturn   = ((cash - 100000) / 100000) * 100;
    const firstPVDate   = new Date(portfolioValues[0].date);
    const lastPVDate    = new Date(portfolioValues[portfolioValues.length - 1].date);
    const totalYears    = (lastPVDate - firstPVDate) / (1000 * 60 * 60 * 24 * 365.25);
    const annualReturn  = totalYears > 0 ? (Math.pow(cash / 100000, 1 / totalYears) - 1) * 100 : 0;

    const periods        = portfolioValues.length;
    const periodsPerYear = 52 / holdPer;
    const avgReturn      = portfolioValues.reduce((s, v) => s + v.return, 0) / periods;
    const volatility     = Math.sqrt(
        portfolioValues.reduce((s, v) => s + Math.pow(v.return - avgReturn, 2), 0) / periods
    );

    const annualAvg   = avgReturn * periodsPerYear;
    const annualVol   = volatility * Math.sqrt(periodsPerYear);
    const sharpeRatio = annualVol > 0 ? annualAvg / annualVol : 0;

    const dsR          = portfolioValues.filter(v => v.return < avgReturn).map(v => v.return);
    const downVol      = Math.sqrt(dsR.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / periods);
    const annualDVol   = downVol * Math.sqrt(periodsPerYear);
    const sortinoRatio = annualDVol > 0 ? annualAvg / annualDVol : sharpeRatio;

    let peak = portfolioValues[0].value, maxDrawdown = 0;
    for (const v of portfolioValues) {
        if (v.value > peak) peak = v.value;
        const dd = ((v.value - peak) / peak) * 100;
        if (dd < maxDrawdown) maxDrawdown = dd;
    }

    return {
        portfolioValues, detailedTrades, currentRecommendations,
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
        tipMetrics: { sharpeRatio, sortinoRatio, maxDrawdown, annualReturn }
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

function runBacktest(settings) {
    const key = getPhase1Key(settings);
    if (key !== phase1CacheKey) {
        momentumMatrix = precomputeMomentumMatrix(settings);
        phase1CacheKey = key;
    }
    return buildPortfolio(settings);
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function(e) {
    const { type } = e.data;

    if (type === 'init') {
        const { excelUrl, sheetjsUrl } = e.data;

        if (!excelUrl) {
            self.postMessage({ type: 'error', message: 'Excel файл не настроен. Перейдите в Настройки > Momentum Week' });
            return;
        }

        // Load SheetJS inside the worker (doesn't block the main thread)
        try {
            importScripts(sheetjsUrl);
        } catch (err) {
            self.postMessage({ type: 'error', message: 'Не удалось загрузить SheetJS: ' + err.message });
            return;
        }

        // Fetch and parse Excel entirely inside the worker
        fetch(excelUrl)
            .then(function(r) {
                if (!r.ok) throw new Error('Ошибка загрузки файла (HTTP ' + r.status + ')');
                return r.arrayBuffer();
            })
            .then(function(buffer) {
                // Parse without cellDates — much faster; dates handled by parseExcelDate()
                const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });

                if (!wb.SheetNames.includes('цены')) {
                    throw new Error('Лист "цены" не найден. Доступные листы: ' + wb.SheetNames.join(', '));
                }

                const priceData = XLSX.utils.sheet_to_json(wb.Sheets['цены'], { defval: null });
                if (!priceData || priceData.length === 0) throw new Error('Файл пуст');

                const divNames    = ['Дивид', 'дивиденды', 'Дивиденды', 'dividends'];
                const divSheetName = divNames.find(function(nm) { return wb.SheetNames.includes(nm); });
                const dividendData = divSheetName
                    ? XLSX.utils.sheet_to_json(wb.Sheets[divSheetName], { defval: null })
                    : null;

                // Set up module state
                tickersCache = Object.keys(priceData[0]).filter(function(k) { return k !== 'Time'; });
                n       = priceData.length;
                m       = tickersCache.length;
                hasDivs = !!dividendData;

                // Build typed-array indexes (priceData/dividendData are local; GC'd after)
                buildIndexes(priceData, dividendData);

                // Reset phase-1 cache
                momentumMatrix = null;
                phase1CacheKey = null;

                // Compute stats for the main thread to display
                const lastRow     = priceData[n - 1];
                const activeCount = tickersCache.filter(function(t) {
                    return lastRow[t] != null && lastRow[t] !== '' && lastRow[t] > 0;
                }).length;

                self.postMessage({
                    type: 'ready',
                    stats: { n: n, m: m, activeTickers: activeCount, tickers: tickersCache }
                });
            })
            .catch(function(err) {
                self.postMessage({ type: 'error', message: err.message });
            });

    } else if (type === 'recalculate') {
        const result = runBacktest(e.data.settings);
        self.postMessage({ type: 'result', id: e.data.id, ...result });
    }
};
