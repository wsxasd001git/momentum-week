/**
 * Momentum Screener – Web Worker  (v3 – O(n·m) Phase 1)
 *
 * Architecture
 * ────────────
 * On 'init':
 *   buildIndexes() converts row-oriented data to column-oriented typed arrays
 *   and precomputes:
 *     pricesByTicker[t]          – Float64Array of prices  (NaN = missing)
 *     validRunByTicker[t]        – Uint16Array: consecutive-valid-price count
 *     returnPrefixSum[t]         – Float64Array: cumulative sum of weekly returns
 *     returnPrefixSumSq[t]       – Float64Array: cumulative sum of returns²
 *     divPrefixByTicker[t]       – Float64Array: cumulative dividend sums
 *
 * On 'recalculate':
 *   Phase 1  – precomputeMomentumMatrix (expensive, depends on lookback/skip/
 *              dividends/vol/riskAdj).  Now O(n·m) thanks to prefix-sum vol
 *              and validRun continuity check.  Cached via phase1CacheKey.
 *   Phase 2  – buildPortfolio (cheap, depends on topN/holdingPeriod/returnFilter).
 *              Re-slices cached scores.
 */

'use strict';

// ─── Raw data ───────────────────────────────────────────────────────────────
let priceData     = null;
let dividendData  = null;
let tickersCache  = null;

// ─── Pre-indexed structures ─────────────────────────────────────────────────
let pricesByTicker       = {};  // ticker → Float64Array[n]
let validRunByTicker     = {};  // ticker → Uint16Array[n]  (consecutive valid cnt)
let returnPrefixSum      = {};  // ticker → Float64Array[n] (prefix sum of returns)
let returnPrefixSumSq    = {};  // ticker → Float64Array[n] (prefix sum of returns²)
let divPrefixByTicker    = {};  // ticker → Float64Array[n+1]
let dates                = [];  // Date[n]

// ─── Phase 1 cache ──────────────────────────────────────────────────────────
let momentumMatrix  = null;
let phase1CacheKey  = null;

// ════════════════════════════════════════════════════════════════════════════
// buildIndexes – runs once on 'init'
// ════════════════════════════════════════════════════════════════════════════

function buildIndexes() {
    const n = priceData.length;
    const m = tickersCache.length;

    // ── Date cache ──────────────────────────────────────────────────────────
    dates = new Array(n);
    for (let i = 0; i < n; i++) {
        dates[i] = new Date(priceData[i].Time);
    }

    // ── Per-ticker arrays ───────────────────────────────────────────────────
    for (let ti = 0; ti < m; ti++) {
        const ticker = tickersCache[ti];

        // prices
        const prices = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const v = priceData[i][ticker];
            prices[i] = (v && v > 0) ? v : NaN;
        }
        pricesByTicker[ticker] = prices;

        // validRun: validRun[i] = number of consecutive non-NaN prices ending
        // at index i (inclusive).  validRun[i] >= windowSize ⇒ data is
        // continuous over the window.
        const run = new Uint16Array(n);
        run[0] = isNaN(prices[0]) ? 0 : 1;
        for (let i = 1; i < n; i++) {
            run[i] = isNaN(prices[i]) ? 0 : run[i - 1] + 1;
        }
        validRunByTicker[ticker] = run;

        // Weekly returns and their prefix sums (for O(1) volatility).
        // return[i] = (prices[i] - prices[i-1]) / prices[i-1], i >= 1
        // prefixSum[0] = 0,  prefixSum[i] = sum(return[1..i])
        // prefixSumSq[0] = 0, prefixSumSq[i] = sum(return[1..i]²)
        const pSum  = new Float64Array(n);
        const pSumS = new Float64Array(n);
        // pSum[0] = pSumS[0] = 0 (default for Float64Array)
        for (let i = 1; i < n; i++) {
            const p0 = prices[i - 1], p1 = prices[i];
            if (!isNaN(p0) && !isNaN(p1) && p0 > 0) {
                const r = (p1 - p0) / p0;
                pSum[i]  = pSum[i - 1]  + r;
                pSumS[i] = pSumS[i - 1] + r * r;
            } else {
                pSum[i]  = pSum[i - 1];
                pSumS[i] = pSumS[i - 1];
            }
        }
        returnPrefixSum[ticker]   = pSum;
        returnPrefixSumSq[ticker] = pSumS;

        // Dividend prefix sums
        const dPrefix = new Float64Array(n + 1);
        if (dividendData) {
            for (let i = 0; i < n; i++) {
                const row = dividendData[i];
                dPrefix[i + 1] = dPrefix[i] + ((row && row[ticker]) ? row[ticker] : 0);
            }
        }
        divPrefixByTicker[ticker] = dPrefix;
    }

    // Free raw data references (no longer needed, indexes replace them)
    // Keep priceData only for row count; dividendData likewise.
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

/**
 * O(1) volatility via prefix sums.
 * Returns annualised weekly std-dev × 100.
 * Window: returns from index (start+1) to (end), i.e. count = end - start.
 */
function calcVolFast(ticker, start, end) {
    const count = end - start;
    if (count < 2) return 0;

    const pSum  = returnPrefixSum[ticker];
    const pSumS = returnPrefixSumSq[ticker];

    const sumR  = pSum[end]  - pSum[start];
    const sumR2 = pSumS[end] - pSumS[start];

    const mean     = sumR / count;
    const variance = sumR2 / count - mean * mean;
    return Math.sqrt(Math.max(0, variance)) * 100;
}

/** O(1) dividend sum for [from, to] inclusive. */
function getDivSum(ticker, from, to) {
    const prefix = divPrefixByTicker[ticker];
    const f = Math.max(0, from);
    const t = Math.min(to, priceData.length - 1);
    if (f > t) return 0;
    return prefix[t + 1] - prefix[f];
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 1 – precompute momentum matrix  O(n · m)
// ════════════════════════════════════════════════════════════════════════════

function getPhase1Key(s) {
    return [s.lookbackPeriod, s.skipWeeks, s.useDividends,
            s.useVolFilter, s.maxVol, s.useRiskAdj].join('|');
}

function precomputeMomentumMatrix(settings) {
    const n    = priceData.length;
    const skip = settings.skipWeeks;
    const lb   = settings.lookbackPeriod;
    const startMin = lb + skip;
    const matrix = new Array(n).fill(null);

    for (let i = startMin; i < n; i++) {
        const scores = [];

        for (const ticker of tickersCache) {
            const prices = pricesByTicker[ticker];
            const curP   = prices[i];
            if (isNaN(curP)) continue;

            const pastIdx = i - lb - skip;
            if (pastIdx < 0) continue;
            const pastP = prices[pastIdx];
            if (isNaN(pastP)) continue;

            // O(1) data continuity check via validRun
            const volStart    = Math.max(0, pastIdx);
            const windowSize  = i - volStart + 1;
            if (validRunByTicker[ticker][i] < windowSize) continue;

            // O(1) volatility via prefix sums
            const vol = calcVolFast(ticker, volStart, i);
            if (settings.useVolFilter && vol > settings.maxVol) continue;

            // Return
            const priceReturn = (curP - pastP) / pastP;
            let totalReturn = priceReturn;

            if (settings.useDividends && dividendData) {
                const divStart = pastIdx + 1;
                const divEnd   = skip > 0 ? i - skip : i;
                totalReturn = priceReturn + getDivSum(ticker, divStart, divEnd) / pastP;
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
    const n        = priceData.length;
    const startIdx = settings.lookbackPeriod + settings.skipWeeks;
    const holdPer  = settings.holdingPeriod;
    const topN     = settings.topN;
    const useRetF  = settings.useReturnFilter;
    const minRet   = settings.minReturn;
    const maxRet   = settings.maxReturn;
    const useDiv   = settings.useDividends && !!dividendData;

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

            let prRet = (sellPrice - buyPrice) / buyPrice;
            let stRet = prRet;

            if (useDiv) {
                stRet = prRet + getDivSum(stock.ticker, i + 1, i + holdPer) / buyPrice;
            }

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

        portfolioValues.push({
            date:   formatDate(dates[i]),
            value:  cash,
            return: periodReturn * 100
        });

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

    // ── Metrics ─────────────────────────────────────────────────────────────
    const totalReturn  = ((cash - 100000) / 100000) * 100;
    const firstPVDate  = new Date(portfolioValues[0].date);
    const lastPVDate   = new Date(portfolioValues[portfolioValues.length - 1].date);
    const totalYears   = (lastPVDate - firstPVDate) / (1000 * 60 * 60 * 24 * 365.25);
    const annualReturn = totalYears > 0 ? (Math.pow(cash / 100000, 1 / totalYears) - 1) * 100 : 0;

    const periods       = portfolioValues.length;
    const periodsPerYear = 52 / holdPer;
    const avgReturn     = portfolioValues.reduce((s, v) => s + v.return, 0) / periods;
    const volatility    = Math.sqrt(
        portfolioValues.reduce((s, v) => s + Math.pow(v.return - avgReturn, 2), 0) / periods
    );

    const annualAvg   = avgReturn * periodsPerYear;
    const annualVol   = volatility * Math.sqrt(periodsPerYear);
    const sharpeRatio = annualVol > 0 ? annualAvg / annualVol : 0;

    const dsReturns    = portfolioValues.filter(v => v.return < avgReturn).map(v => v.return);
    const downVol      = Math.sqrt(
        dsReturns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / periods
    );
    const annualDownVol = downVol * Math.sqrt(periodsPerYear);
    const sortinoRatio  = annualDownVol > 0 ? annualAvg / annualDownVol : sharpeRatio;

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
        momentumMatrix = precomputeMomentumMatrix(settings);
        phase1CacheKey = key;
    }

    return buildPortfolio(settings);
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function(e) {
    const { type } = e.data;

    if (type === 'init') {
        priceData    = e.data.priceData;
        dividendData = e.data.dividendData;
        tickersCache = e.data.tickersCache;

        buildIndexes();

        momentumMatrix = null;
        phase1CacheKey = null;

        self.postMessage({ type: 'ready' });

    } else if (type === 'recalculate') {
        const result = runBacktest(e.data.settings);
        self.postMessage({ type: 'result', id: e.data.id, ...result });
    }
};
