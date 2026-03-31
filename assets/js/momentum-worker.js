/**
 * Momentum Screener - Web Worker
 * Runs heavy backtest calculations off the main thread.
 *
 * Optimisations vs v1:
 *  - Data is pre-indexed per ticker (pricesByTicker / divPrefixByTicker)
 *    so hot-loop lookups are O(1) array reads instead of object-key hashes.
 *  - Dividend sums use prefix arrays: O(1) per query instead of O(k).
 *  - Calculation is split into two phases:
 *      Phase 1 – precompute momentum scores for every week  (expensive)
 *      Phase 2 – build portfolio using cached scores        (cheap)
 *    A cache key tracks the settings that affect Phase 1.
 *    When only topN / holdingPeriod / returnFilter change → skip Phase 1.
 */

'use strict';

// ─── Raw data (set once on 'init') ──────────────────────────────────────────
let priceData    = null;
let dividendData = null;
let tickersCache = null;

// ─── Pre-indexed structures (built once on 'init') ──────────────────────────
let pricesByTicker   = {};   // ticker → Float64Array[timeIdx]  (NaN = missing)
let divPrefixByTicker = {};  // ticker → Float64Array[timeIdx+1] (prefix sums)
let dates = [];               // Date objects for every row

// ─── Phase-1 cache ──────────────────────────────────────────────────────────
let momentumMatrix  = null;   // Array[timeIdx] → sorted score objects (or null)
let phase1CacheKey  = null;

// ════════════════════════════════════════════════════════════════════════════
// Pre-indexing  (runs once after data arrives)
// ════════════════════════════════════════════════════════════════════════════

function buildIndexes() {
    const n = priceData.length;

    // Date cache
    dates = new Array(n);
    for (let i = 0; i < n; i++) {
        dates[i] = new Date(priceData[i].Time);
    }

    // Price arrays per ticker
    pricesByTicker = {};
    for (const ticker of tickersCache) {
        const arr = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const v = priceData[i][ticker];
            arr[i] = (v && v > 0) ? v : NaN;
        }
        pricesByTicker[ticker] = arr;
    }

    // Dividend prefix sums per ticker (length = n+1, index 0 = 0)
    divPrefixByTicker = {};
    if (dividendData) {
        for (const ticker of tickersCache) {
            const prefix = new Float64Array(n + 1); // prefix[0] = 0
            for (let i = 0; i < n; i++) {
                const row = dividendData[i];
                const d = (row && row[ticker]) ? row[ticker] : 0;
                prefix[i + 1] = prefix[i] + d;
            }
            divPrefixByTicker[ticker] = prefix;
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

/** Annualised weekly volatility (weekly std-dev * 100). */
function calcVol(prices, start, end) {
    // prices is a Float64Array; [start, end] inclusive
    const len = end - start + 1;
    if (len < 2) return 0;

    let sumR = 0, count = 0;
    const returns = new Float64Array(len - 1);
    for (let i = start + 1; i <= end; i++) {
        const p0 = prices[i - 1], p1 = prices[i];
        if (!isNaN(p0) && !isNaN(p1) && p0 > 0) {
            const r = (p1 - p0) / p0;
            returns[count++] = r;
            sumR += r;
        }
    }
    if (count === 0) return 0;

    const avg = sumR / count;
    let varSum = 0;
    for (let i = 0; i < count; i++) {
        const diff = returns[i] - avg;
        varSum += diff * diff;
    }
    return Math.sqrt(varSum / count) * 100;
}

/** Dividend sum for ticker in row range [from, to] inclusive. */
function getDivSum(ticker, from, to) {
    const prefix = divPrefixByTicker[ticker];
    if (!prefix) return 0;
    const f = Math.max(0, from);
    const t = Math.min(to, priceData.length - 1);
    if (f > t) return 0;
    return prefix[t + 1] - prefix[f];
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 1 – pre-compute momentum scores for every week
// ════════════════════════════════════════════════════════════════════════════

function getPhase1Key(s) {
    return `${s.lookbackPeriod}|${s.skipWeeks}|${s.useDividends}|${s.useVolFilter}|${s.maxVol}|${s.useRiskAdj}`;
}

/**
 * Build momentumMatrix[i] = array of score objects sorted by momentum desc.
 * Only the columns (tickers) that have complete data in the window are included.
 * returnFilter is NOT applied here (it's applied in Phase 2 so cache stays reusable).
 */
function precomputeMomentumMatrix(settings) {
    const n = priceData.length;
    const matrix = new Array(n).fill(null);
    const skip = settings.skipWeeks;
    const lb   = settings.lookbackPeriod;
    const startMin = lb + skip;

    for (let i = startMin; i < n; i++) {
        const scores = [];

        for (const ticker of tickersCache) {
            const prices = pricesByTicker[ticker];
            const currentPrice = prices[i];
            if (isNaN(currentPrice)) continue;

            const pastIdx = i - lb - skip;
            if (pastIdx < 0) continue;
            const pastPrice = prices[pastIdx];
            if (isNaN(pastPrice)) continue;

            // Check data continuity over the volatility window
            const volStart = Math.max(0, i - lb - skip);
            const expectedPts = i - volStart + 1;
            let validPts = 0;
            for (let j = volStart; j <= i; j++) {
                if (!isNaN(prices[j])) validPts++;
            }
            if (validPts < expectedPts) continue;

            const vol = calcVol(prices, volStart, i);
            if (settings.useVolFilter && vol > settings.maxVol) continue;

            const priceReturn = (currentPrice - pastPrice) / pastPrice;
            let totalReturn = priceReturn;

            if (settings.useDividends && dividendData) {
                const divStart = pastIdx + 1;
                const divEnd   = skip > 0 ? i - skip : i;
                const divSum   = getDivSum(ticker, divStart, divEnd);
                totalReturn = priceReturn + divSum / pastPrice;
            }

            let momentum = totalReturn;
            if (settings.useRiskAdj && vol > 0) {
                momentum = (totalReturn * 100) / vol;
            }

            scores.push({ ticker, momentum, price: currentPrice, volatility: vol, rawReturn: totalReturn });
        }

        scores.sort((a, b) => b.momentum - a.momentum);
        matrix[i] = scores;
    }

    return matrix;
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 2 – build portfolio from (cached) momentum matrix
// ════════════════════════════════════════════════════════════════════════════

function buildPortfolio(settings) {
    const n         = priceData.length;
    const startIdx  = settings.lookbackPeriod + settings.skipWeeks;
    const holdPer   = settings.holdingPeriod;
    const topN      = settings.topN;
    const useRetF   = settings.useReturnFilter;
    const minRet    = settings.minReturn;
    const maxRet    = settings.maxReturn;
    const useDiv    = settings.useDividends && !!dividendData;

    if (startIdx >= n - holdPer) {
        return { error: 'Недостаточно данных для расчета. Попробуйте уменьшить период расчета momentum.' };
    }

    const portfolioValues = [];
    const detailedTrades  = [];
    let cash = 100000;

    for (let i = startIdx; i < n - holdPer; i += holdPer) {
        let allScores = momentumMatrix[i];
        if (!allScores || allScores.length === 0) continue;

        // Apply return filter (not cached in Phase 1)
        if (useRetF) {
            allScores = allScores.filter(s => {
                const rp = s.rawReturn * 100;
                return rp >= minRet && rp <= maxRet;
            });
        }

        const selectedStocks = allScores.slice(0, topN);
        if (selectedStocks.length === 0) continue;

        let periodReturn = 0;
        const stockDetails = [];

        for (const stock of selectedStocks) {
            const buyPrice  = stock.price;
            const sellPrice = pricesByTicker[stock.ticker][i + holdPer];
            if (isNaN(sellPrice) || sellPrice <= 0) continue;

            let priceReturn = (sellPrice - buyPrice) / buyPrice;
            let stockReturn = priceReturn;

            if (useDiv) {
                const divSum = getDivSum(stock.ticker, i + 1, i + holdPer);
                stockReturn  = priceReturn + divSum / buyPrice;
            }

            periodReturn += stockReturn / selectedStocks.length;

            stockDetails.push({
                ticker:    stock.ticker,
                momentum:  stock.momentum,
                buyPrice:  buyPrice.toFixed(2),
                sellPrice: sellPrice.toFixed(2),
                return:    (stockReturn * 100).toFixed(2),
                weight:    (100 / selectedStocks.length).toFixed(1)
            });
        }

        cash *= (1 + periodReturn);

        portfolioValues.push({
            date:   formatDate(dates[i]),
            value:  cash,
            return: periodReturn * 100
        });

        detailedTrades.push({
            date:        formatDate(dates[i]),
            sellDate:    formatDate(dates[i + holdPer]),
            totalReturn: (periodReturn * 100).toFixed(2),
            stockCount:  selectedStocks.length,
            stocks:      stockDetails
        });
    }

    if (portfolioValues.length === 0) {
        return { error: 'Недостаточно данных для расчета' };
    }

    // Current recommendations (last row)
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
        const selected = recScores.slice(0, topN);
        currentRecommendations = {
            date:          formatDate(dates[lastIdx]),
            stocks:        selected.map((s, idx) => ({
                ticker:     s.ticker,
                price:      s.price.toFixed(2),
                momentum:   (s.momentum * 100).toFixed(2),
                rawReturn:  (s.rawReturn * 100).toFixed(2),
                volatility: s.volatility.toFixed(2),
                weight:     (100 / topN).toFixed(1),
                rank:       idx + 1
            })),
            portfolioSize: selected.length
        };
    }

    // Metrics
    const totalReturn  = ((cash - 100000) / 100000) * 100;
    const firstDate    = dates[portfolioValues[0] ? startIdx : startIdx]; // approx
    const lastPVDate   = new Date(portfolioValues[portfolioValues.length - 1].date);
    const firstPVDate  = new Date(portfolioValues[0].date);
    const totalYears   = (lastPVDate - firstPVDate) / (1000 * 60 * 60 * 24 * 365.25);
    const annualReturn = totalYears > 0 ? (Math.pow(cash / 100000, 1 / totalYears) - 1) * 100 : 0;

    const periods       = portfolioValues.length;
    const periodsPerYear = 52 / holdPer;
    const avgReturn     = portfolioValues.reduce((s, v) => s + v.return, 0) / periods;
    const volatility    = Math.sqrt(
        portfolioValues.reduce((s, v) => s + Math.pow(v.return - avgReturn, 2), 0) / periods
    );

    const annualAvgReturn = avgReturn * periodsPerYear;
    const annualVol       = volatility * Math.sqrt(periodsPerYear);
    const sharpeRatio     = annualVol > 0 ? annualAvgReturn / annualVol : 0;

    const downsideReturns = portfolioValues.filter(v => v.return < avgReturn).map(v => v.return);
    const downVol = Math.sqrt(
        downsideReturns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / periods
    );
    const annualDownVol = downVol * Math.sqrt(periodsPerYear);
    const sortinoRatio  = annualDownVol > 0 ? annualAvgReturn / annualDownVol : sharpeRatio;

    let peak = portfolioValues[0].value;
    let maxDrawdown = 0;
    for (const v of portfolioValues) {
        if (v.value > peak) peak = v.value;
        const dd = ((v.value - peak) / peak) * 100;
        if (dd < maxDrawdown) maxDrawdown = dd;
    }

    return {
        portfolioValues,
        detailedTrades,
        currentRecommendations,
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
        // Settings that affect momentum scores changed → recompute matrix
        momentumMatrix = precomputeMomentumMatrix(settings);
        phase1CacheKey = key;
    }
    // else: only topN / holdingPeriod / returnFilter changed → reuse matrix

    return buildPortfolio(settings);
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function(e) {
    const { type } = e.data;

    if (type === 'init') {
        priceData    = e.data.priceData;
        dividendData = e.data.dividendData;
        tickersCache = e.data.tickersCache;

        // Pre-index everything once so hot loops use typed arrays
        buildIndexes();

        // Invalidate phase-1 cache
        momentumMatrix = null;
        phase1CacheKey = null;

        self.postMessage({ type: 'ready' });

    } else if (type === 'recalculate') {
        const result = runBacktest(e.data.settings);
        self.postMessage({ type: 'result', id: e.data.id, ...result });
    }
};
