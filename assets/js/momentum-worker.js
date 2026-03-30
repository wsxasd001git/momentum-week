/**
 * Momentum Screener - Web Worker
 * Runs heavy backtest calculations off the main thread
 */

'use strict';

let priceData = null;
let dividendData = null;
let tickersCache = null;

// ─── Pure calculation helpers ────────────────────────────────────────────────

function calcVol(prices) {
    if (prices.length < 2) return 0;

    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        if (prices[i] && prices[i - 1] && prices[i - 1] > 0) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }
    }

    if (returns.length === 0) return 0;

    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / returns.length;
    return Math.sqrt(variance) * 100;
}

function formatDate(date) {
    if (typeof date === 'string') date = new Date(date);
    return date.toISOString().split('T')[0];
}

function getActiveTickers(idx) {
    return tickersCache.filter(ticker =>
        priceData[idx][ticker] && priceData[idx][ticker] > 0
    );
}

function calcMomentumAtIndex(i, settings) {
    const currentDate = new Date(priceData[i].Time);
    const momentumScores = [];
    const activeTickers = getActiveTickers(i);

    activeTickers.forEach(ticker => {
        const currentPrice = priceData[i][ticker];
        let pastPrice, dividendStartIdx, dividendEndIdx;

        if (settings.skipWeeks > 0) {
            if (i - settings.lookbackPeriod - settings.skipWeeks < 0) return;
            pastPrice = priceData[i - settings.lookbackPeriod - settings.skipWeeks][ticker];
            dividendStartIdx = i - settings.lookbackPeriod - settings.skipWeeks + 1;
            dividendEndIdx = i - settings.skipWeeks;
        } else {
            if (i - settings.lookbackPeriod < 0) return;
            pastPrice = priceData[i - settings.lookbackPeriod][ticker];
            dividendStartIdx = i - settings.lookbackPeriod + 1;
            dividendEndIdx = i;
        }

        if (currentPrice && pastPrice && currentPrice > 0 && pastPrice > 0) {
            const prices = [];
            const volStartIdx = i - settings.lookbackPeriod - settings.skipWeeks;
            const expectedDataPoints = i - Math.max(0, volStartIdx) + 1;

            for (let j = Math.max(0, volStartIdx); j <= i; j++) {
                if (priceData[j][ticker] && priceData[j][ticker] > 0) {
                    prices.push(priceData[j][ticker]);
                }
            }

            if (prices.length < expectedDataPoints) return;

            const vol = calcVol(prices);

            if (settings.useVolFilter && vol > settings.maxVol) return;

            let priceReturn = (currentPrice - pastPrice) / pastPrice;
            let totalReturn = priceReturn;

            if (settings.useDividends && dividendData) {
                let dividendReturn = 0;
                for (let j = dividendStartIdx; j <= dividendEndIdx; j++) {
                    if (j >= 0 && j < dividendData.length) {
                        const divRow = dividendData[j];
                        if (divRow && divRow[ticker] && pastPrice > 0) {
                            dividendReturn += divRow[ticker] / pastPrice;
                        }
                    }
                }
                totalReturn = priceReturn + dividendReturn;
            }

            if (settings.useReturnFilter) {
                const returnPct = totalReturn * 100;
                if (returnPct < settings.minReturn || returnPct > settings.maxReturn) return;
            }

            let momentum = totalReturn;
            if (settings.useRiskAdj && vol > 0) {
                momentum = (totalReturn * 100) / vol;
            }

            momentumScores.push({ ticker, momentum, price: currentPrice, volatility: vol, rawReturn: totalReturn });
        }
    });

    momentumScores.sort((a, b) => b.momentum - a.momentum);

    return {
        selectedStocks: momentumScores.slice(0, settings.topN),
        date: currentDate
    };
}

// ─── Main backtest ────────────────────────────────────────────────────────────

function runBacktest(settings) {
    const portfolioValues = [];
    const detailedTrades = [];
    let cash = 100000;
    const startIdx = settings.lookbackPeriod + settings.skipWeeks;

    if (startIdx >= priceData.length - settings.holdingPeriod) {
        return { error: 'Недостаточно данных для расчета. Попробуйте уменьшить период расчета momentum.' };
    }

    for (let i = startIdx; i < priceData.length - settings.holdingPeriod; i += settings.holdingPeriod) {
        const { selectedStocks } = calcMomentumAtIndex(i, settings);
        const currentDate = new Date(priceData[i].Time);

        if (selectedStocks.length === 0) continue;

        let periodReturn = 0;
        const stockDetails = [];

        selectedStocks.forEach(stock => {
            const buyPrice = stock.price;
            const sellPrice = priceData[i + settings.holdingPeriod][stock.ticker];

            if (sellPrice && sellPrice > 0) {
                let priceReturn = (sellPrice - buyPrice) / buyPrice;
                let stockReturn = priceReturn;

                if (settings.useDividends && dividendData) {
                    let dividendReturn = 0;
                    for (let j = i + 1; j <= i + settings.holdingPeriod && j < priceData.length; j++) {
                        if (j < dividendData.length) {
                            const divRow = dividendData[j];
                            if (divRow && divRow[stock.ticker] && buyPrice > 0) {
                                dividendReturn += divRow[stock.ticker] / buyPrice;
                            }
                        }
                    }
                    stockReturn = priceReturn + dividendReturn;
                }

                periodReturn += stockReturn / selectedStocks.length;

                stockDetails.push({
                    ticker: stock.ticker,
                    momentum: stock.momentum,
                    buyPrice: buyPrice.toFixed(2),
                    sellPrice: sellPrice.toFixed(2),
                    return: (stockReturn * 100).toFixed(2),
                    weight: (100 / selectedStocks.length).toFixed(1)
                });
            }
        });

        cash *= (1 + periodReturn);

        portfolioValues.push({
            date: formatDate(currentDate),
            value: cash,
            return: periodReturn * 100
        });

        detailedTrades.push({
            date: formatDate(currentDate),
            sellDate: formatDate(new Date(priceData[i + settings.holdingPeriod].Time)),
            totalReturn: (periodReturn * 100).toFixed(2),
            stockCount: selectedStocks.length,
            stocks: stockDetails
        });
    }

    if (portfolioValues.length === 0) {
        return { error: 'Недостаточно данных для расчета' };
    }

    // Current recommendations (last available row)
    const lastIdx = priceData.length - 1;
    let currentRecommendations = null;
    if (lastIdx >= startIdx) {
        const { selectedStocks, date } = calcMomentumAtIndex(lastIdx, settings);
        currentRecommendations = {
            date: formatDate(date),
            stocks: selectedStocks.map((s, idx) => ({
                ticker: s.ticker,
                price: s.price.toFixed(2),
                momentum: (s.momentum * 100).toFixed(2),
                rawReturn: (s.rawReturn * 100).toFixed(2),
                volatility: s.volatility.toFixed(2),
                weight: (100 / settings.topN).toFixed(1),
                rank: idx + 1
            })),
            portfolioSize: selectedStocks.length
        };
    }

    // Metrics
    const totalReturn = ((cash - 100000) / 100000) * 100;
    const firstDate = new Date(portfolioValues[0].date);
    const lastDate  = new Date(portfolioValues[portfolioValues.length - 1].date);
    const totalYears = (lastDate - firstDate) / (1000 * 60 * 60 * 24 * 365.25);
    const annualReturn = totalYears > 0 ? (Math.pow(cash / 100000, 1 / totalYears) - 1) * 100 : 0;

    const periods = portfolioValues.length;
    const periodsPerYear = 52 / settings.holdingPeriod;
    const avgReturn = portfolioValues.reduce((sum, v) => sum + v.return, 0) / periods;
    const volatility = Math.sqrt(
        portfolioValues.reduce((sum, v) => sum + Math.pow(v.return - avgReturn, 2), 0) / periods
    );

    const annualAvgReturn = avgReturn * periodsPerYear;
    const annualVol = volatility * Math.sqrt(periodsPerYear);
    const sharpeRatio = annualVol > 0 ? annualAvgReturn / annualVol : 0;

    const downsideReturns = portfolioValues.filter(v => v.return < avgReturn).map(v => v.return);
    const downVol = Math.sqrt(
        downsideReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / periods
    );
    const annualDownVol = downVol * Math.sqrt(periodsPerYear);
    const sortinoRatio = annualDownVol > 0 ? annualAvgReturn / annualDownVol : sharpeRatio;

    let peak = portfolioValues[0].value;
    let maxDrawdown = 0;
    portfolioValues.forEach(v => {
        if (v.value > peak) peak = v.value;
        const drawdown = ((v.value - peak) / peak) * 100;
        if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    });

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

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function(e) {
    const { type } = e.data;

    if (type === 'init') {
        priceData    = e.data.priceData;
        dividendData = e.data.dividendData;
        tickersCache = e.data.tickersCache;
        self.postMessage({ type: 'ready' });

    } else if (type === 'recalculate') {
        const result = runBacktest(e.data.settings);
        self.postMessage({ type: 'result', id: e.data.id, ...result });
    }
};
