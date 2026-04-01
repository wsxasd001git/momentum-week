(function () {
'use strict';

const { createElement, useState, useMemo, useEffect, useRef, useCallback, Fragment } = window.React;
const html = window.htm.bind(createElement);

// ─── Computation helpers ──────────────────────────────────────────────

function parseExcelDate(val) {
    if (val instanceof Date) return val;
    if (typeof val === 'number') {
        return new Date(Math.round((val - 25569) * 86400000));
    }
    return new Date(val);
}

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function buildIndexes(pricesRaw, dividendsRaw) {
    if (!pricesRaw || pricesRaw.length === 0) return null;

    const tickers = Object.keys(pricesRaw[0]).filter(k => k !== 'Time');
    const n       = pricesRaw.length;
    const m       = tickers.length;
    const hasDivs = !!(dividendsRaw && dividendsRaw.length > 0);

    const dates = new Array(n);
    for (let i = 0; i < n; i++) {
        dates[i] = parseExcelDate(pricesRaw[i].Time);
    }

    const pricesBy  = {};
    const runBy     = {};
    const pSumBy    = {};
    const pSumSqBy  = {};
    const dPrefixBy = {};

    for (let ti = 0; ti < m; ti++) {
        const ticker = tickers[ti];

        const prices = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const v = pricesRaw[i][ticker];
            prices[i] = (v != null && v > 0) ? v : NaN;
        }
        pricesBy[ticker] = prices;

        const run = new Uint16Array(n);
        run[0] = isNaN(prices[0]) ? 0 : 1;
        for (let i = 1; i < n; i++) {
            run[i] = isNaN(prices[i]) ? 0 : Math.min(run[i - 1] + 1, 65535);
        }
        runBy[ticker] = run;

        const pSum  = new Float64Array(n);
        const pSumS = new Float64Array(n);
        for (let i = 1; i < n; i++) {
            const p0 = prices[i - 1], p1 = prices[i];
            if (!isNaN(p0) && !isNaN(p1) && p0 > 0) {
                const r  = (p1 - p0) / p0;
                pSum[i]  = pSum[i - 1] + r;
                pSumS[i] = pSumS[i - 1] + r * r;
            } else {
                pSum[i]  = pSum[i - 1];
                pSumS[i] = pSumS[i - 1];
            }
        }
        pSumBy[ticker]   = pSum;
        pSumSqBy[ticker] = pSumS;

        const dPrefix = new Float64Array(n + 1);
        if (dividendsRaw) {
            const dLen = dividendsRaw.length;
            for (let i = 0; i < n && i < dLen; i++) {
                const row  = dividendsRaw[i];
                dPrefix[i + 1] = dPrefix[i] + ((row && row[ticker]) ? row[ticker] : 0);
            }
            for (let i = dLen; i < n; i++) {
                dPrefix[i + 1] = dPrefix[i];
            }
        }
        dPrefixBy[ticker] = dPrefix;
    }

    const lastRow       = pricesRaw[n - 1];
    const activeTickers = tickers.filter(t => lastRow[t] != null && lastRow[t] > 0).length;

    return { n, m, tickers, hasDivs, dates, pricesBy, runBy, pSumBy, pSumSqBy, dPrefixBy, activeTickers };
}

function calcVol(idx, ticker, start, end) {
    const count = end - start;
    if (count < 2) return 0;
    const sumR  = idx.pSumBy[ticker][end]   - idx.pSumBy[ticker][start];
    const sumR2 = idx.pSumSqBy[ticker][end] - idx.pSumSqBy[ticker][start];
    const mean  = sumR / count;
    return Math.sqrt(Math.max(0, sumR2 / count - mean * mean)) * 100;
}

function getDivSum(idx, ticker, from, to) {
    const f = Math.max(0, from);
    const t = Math.min(to, idx.n - 1);
    if (f > t) return 0;
    return idx.dPrefixBy[ticker][t + 1] - idx.dPrefixBy[ticker][f];
}

function buildMatrix(idx, settings) {
    const { n, m, tickers, hasDivs, pricesBy, runBy } = idx;
    const { lookbackPeriod: lb, skipWeeks: skip,
            useDividends, useVolFilter, maxVol, useRiskAdj } = settings;
    const startMin = lb + skip;
    const matrix   = new Array(n).fill(null);

    for (let i = startMin; i < n; i++) {
        const scores = [];

        for (let ti = 0; ti < m; ti++) {
            const ticker = tickers[ti];
            const prices = pricesBy[ticker];
            const curP   = prices[i];
            if (isNaN(curP)) continue;

            const pastIdx = i - lb - skip;
            if (pastIdx < 0) continue;
            const pastP = prices[pastIdx];
            if (isNaN(pastP)) continue;

            const volStart   = Math.max(0, pastIdx);
            const windowSize = i - volStart + 1;
            if (runBy[ticker][i] < windowSize) continue;

            const vol = calcVol(idx, ticker, volStart, i);
            if (useVolFilter && vol > maxVol) continue;

            const priceReturn = (curP - pastP) / pastP;
            let   totalReturn = priceReturn;

            if (useDividends && hasDivs) {
                const divStart = pastIdx + 1;
                const divEnd   = skip > 0 ? i - skip : i;
                totalReturn    = priceReturn + getDivSum(idx, ticker, divStart, divEnd) / pastP;
            }

            let momentum = totalReturn;
            if (useRiskAdj && vol > 0) {
                momentum = (totalReturn * 100) / vol;
            }

            scores.push({ ticker, momentum, price: curP, vol, rawRet: totalReturn });
        }

        scores.sort((a, b) => b.momentum - a.momentum);
        matrix[i] = scores;
    }

    return matrix;
}

function buildPortfolio(idx, matrix, settings) {
    const { n, hasDivs, dates, pricesBy } = idx;
    const { lookbackPeriod, skipWeeks, holdingPeriod: holdPer, topN,
            useDividends, useReturnFilter: useRetF,
            minReturn: minRet, maxReturn: maxRet } = settings;
    const useDiv   = useDividends && hasDivs;
    const startIdx = lookbackPeriod + skipWeeks;

    if (startIdx >= n - holdPer) {
        return { error: 'Недостаточно данных для расчёта. Попробуйте уменьшить период расчёта momentum.' };
    }

    const portfolioValues = [];
    const detailedTrades  = [];
    let   cash = 100000;

    for (let i = startIdx; i < n - holdPer; i += holdPer) {
        let allScores = matrix[i];
        if (!allScores || allScores.length === 0) continue;

        if (useRetF) {
            allScores = allScores.filter(s => {
                const rp = s.rawRet * 100;
                return rp >= minRet && rp <= maxRet;
            });
        }

        const selected = allScores.slice(0, topN);
        if (selected.length === 0) continue;

        let periodReturn = 0;
        const stockDetails = [];

        for (let si = 0; si < selected.length; si++) {
            const stock     = selected[si];
            const buyPrice  = stock.price;
            const sellPrice = pricesBy[stock.ticker][i + holdPer];
            if (isNaN(sellPrice) || sellPrice <= 0) continue;

            const prRet = (sellPrice - buyPrice) / buyPrice;
            const stRet = useDiv
                ? prRet + getDivSum(idx, stock.ticker, i + 1, i + holdPer) / buyPrice
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

    const lastIdx = n - 1;
    let currentRecommendations = null;
    if (lastIdx >= startIdx && matrix[lastIdx]) {
        let recScores = matrix[lastIdx];
        if (useRetF) {
            recScores = recScores.filter(s => {
                const rp = s.rawRet * 100;
                return rp >= minRet && rp <= maxRet;
            });
        }
        const sel = recScores.slice(0, topN);
        currentRecommendations = {
            date:          formatDate(dates[lastIdx]),
            portfolioSize: sel.length,
            stocks: sel.map((s, ri) => ({
                ticker:     s.ticker,
                price:      s.price.toFixed(2),
                momentum:   (s.momentum * 100).toFixed(2),
                rawReturn:  (s.rawRet * 100).toFixed(2),
                volatility: s.vol.toFixed(2),
                weight:     (100 / topN).toFixed(1),
                rank:       ri + 1
            }))
        };
    }

    const totalReturn  = ((cash - 100000) / 100000) * 100;
    const firstPVDate  = new Date(portfolioValues[0].date);
    const lastPVDate   = new Date(portfolioValues[portfolioValues.length - 1].date);
    const totalYears   = (lastPVDate - firstPVDate) / (1000 * 60 * 60 * 24 * 365.25);
    const annualReturn = totalYears > 0 ? (Math.pow(cash / 100000, 1 / totalYears) - 1) * 100 : 0;

    const periods        = portfolioValues.length;
    const periodsPerYear = 52 / holdPer;
    const avgReturn = portfolioValues.reduce((s, v) => s + v.return, 0) / periods;
    const volatility = Math.sqrt(
        portfolioValues.reduce((s, v) => s + Math.pow(v.return - avgReturn, 2), 0) / periods
    );

    const annualAvg   = avgReturn * periodsPerYear;
    const annualVol   = volatility * Math.sqrt(periodsPerYear);
    const sharpeRatio = annualVol > 0 ? annualAvg / annualVol : 0;

    const dsR = portfolioValues.filter(v => v.return < avgReturn).map(v => v.return);
    const downVol = Math.sqrt(
        dsR.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / periods
    );
    const annualDVol   = downVol * Math.sqrt(periodsPerYear);
    const sortinoRatio = annualDVol > 0 ? annualAvg / annualDVol : sharpeRatio;

    let peak = portfolioValues[0].value, maxDrawdown = 0;
    for (let vi = 0; vi < portfolioValues.length; vi++) {
        const v = portfolioValues[vi];
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
            trades:       detailedTrades.length,
            years:        totalYears.toFixed(1)
        },
        tipMetrics: { sharpeRatio, sortinoRatio, maxDrawdown, annualReturn }
    };
}

function getTips(tipData, s) {
    const tips = [];
    if (tipData.sharpeRatio > 1)
        tips.push('Отличный коэффициент Шарпа! Стратегия показывает хорошее соотношение доходности и риска.');
    if (tipData.sharpeRatio <= 0.5)
        tips.push('Низкий коэффициент Шарпа. Попробуйте увеличить период расчета momentum или изменить количество акций.');
    if (tipData.sortinoRatio > tipData.sharpeRatio * 1.3)
        tips.push('Коэффициент Сортино значительно выше Шарпа — стратегия хорошо защищена от нисходящих рисков.');
    if (Math.abs(tipData.maxDrawdown) > 30)
        tips.push('Высокая просадка (' + tipData.maxDrawdown.toFixed(2) + '%). Рассмотрите увеличение диверсификации или фильтр волатильности.');
    if (tipData.annualReturn > 15)
        tips.push('Годовая доходность ' + tipData.annualReturn.toFixed(2) + '% превышает исторический рост рынка!');
    if (s.lookbackPeriod < 13)
        tips.push('Короткий период расчета может привести к высокой волатильности. Попробуйте 13–26 недель.');
    if (s.topN > 20)
        tips.push('Большое количество акций может снизить эффект momentum. Оптимум — 10–15 акций.');
    if (s.useVolFilter)
        tips.push('Фильтр волатильности активен — исключаются акции с волатильностью выше ' + s.maxVol + '%.');
    if (s.useRiskAdj)
        tips.push('Риск-корректированный momentum учитывает волатильность при выборе акций.');
    if (s.useReturnFilter)
        tips.push('Фильтр границ доходности активен: от ' + s.minReturn + '% до ' + s.maxReturn + '%.');
    return tips;
}


// ─── Components ────────────────────────────────────────────────────────────────

function Slider({ id, label, value, min, max, step, unit, desc, onChange, locked }) {
    return html`
        <div className=${'ms-control-group' + (locked ? ' ms-control-locked' : '')}>
            <label htmlFor=${id}>${label}</label>
            <input type="range" id=${id} min=${min} max=${max} step=${step || 1}
                   value=${value}
                   onInput=${locked ? undefined : function(e) { onChange(parseInt(e.target.value)); }}
                   disabled=${locked || undefined} />
            <span className="ms-control-value">${value} ${unit}</span>
            ${desc && html`<p className="ms-control-desc">${desc}</p>`}
        </div>
    `;
}

function Toggle({ value, onChange, locked, small }) {
    const base = small ? 'ms-toggle-small' : 'ms-toggle';
    const cls  = base + (value ? ' active' : '') + (locked ? ' ms-locked' : '');
    return html`
        <button className=${cls}
                onClick=${locked ? undefined : function() { onChange(!value); }}
                disabled=${locked || undefined}>
            ${small ? (value ? 'ВКЛ' : 'ВЫКЛ') : (value ? 'Включено' : 'Выключено')}
        </button>
    `;
}

function EquityChart({ pvs }) {
    const ref      = useRef(null);
    const chartRef = useRef(null);

    useEffect(function() {
        chartRef.current = new Chart(ref.current.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label:           'Стоимость портфеля (руб)',
                    data:            [],
                    borderColor:     '#557C4B',
                    backgroundColor: 'rgba(85,124,75,0.1)',
                    fill:            true,
                    tension:         0.1,
                    pointRadius:     2
                }]
            },
            options: {
                responsive: true,
                animation:  false,
                plugins: { legend: { position: 'top' } },
                scales:  { y: { beginAtZero: false } }
            }
        });
        return function() { if (chartRef.current) chartRef.current.destroy(); };
    }, []);

    useEffect(function() {
        if (!chartRef.current) return;
        chartRef.current.data.labels                  = pvs.map(function(v) { return v.date; });
        chartRef.current.data.datasets[0].data        = pvs.map(function(v) { return v.value; });
        chartRef.current.update('none');
    }, [pvs]);

    return html`<canvas ref=${ref}></canvas>`;
}

function ReturnsChart({ pvs }) {
    const ref      = useRef(null);
    const chartRef = useRef(null);

    useEffect(function() {
        chartRef.current = new Chart(ref.current.getContext('2d'), {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    label:           'Доходность периода (%)',
                    data:            [],
                    backgroundColor: []
                }]
            },
            options: {
                responsive: true,
                animation:  false,
                plugins: { legend: { position: 'top' } }
            }
        });
        return function() { if (chartRef.current) chartRef.current.destroy(); };
    }, []);

    useEffect(function() {
        if (!chartRef.current) return;
        const recent = pvs.slice(-50);
        chartRef.current.data.labels                          = recent.map(function(v) { return v.date; });
        chartRef.current.data.datasets[0].data                = recent.map(function(v) { return v.return; });
        chartRef.current.data.datasets[0].backgroundColor     = recent.map(function(v) {
            return v.return >= 0 ? 'rgba(85,124,75,0.7)' : 'rgba(227,45,67,0.7)';
        });
        chartRef.current.update('none');
    }, [pvs]);

    return html`<canvas ref=${ref}></canvas>`;
}

function MomentumApp() {
    const el       = document.getElementById('momentum-screener-root');
    const defaults = {
        lookback: +el.dataset.lookback || 13,
        holding:  +el.dataset.holding  || 4,
        topn:     +el.dataset.topn     || 10
    };
    const locks = {
        lookback:  el.dataset.lockLookback  === '1',
        holding:   el.dataset.lockHolding   === '1',
        topn:      el.dataset.lockTopn      === '1',
        dividends: el.dataset.lockDividends === '1',
        skip:      el.dataset.lockSkip      === '1',
        vol:       el.dataset.lockVol       === '1',
        riskadj:   el.dataset.lockRiskadj   === '1',
        ret:       el.dataset.lockReturn    === '1'
    };

    const [s, setS]           = useState({
        lookbackPeriod:  defaults.lookback,
        holdingPeriod:   defaults.holding,
        topN:            defaults.topn,
        skipWeeks:       4,
        useDividends:    true,
        useVolFilter:    false,
        maxVol:          50,
        useRiskAdj:      false,
        useReturnFilter: false,
        minReturn:       30,
        maxReturn:       160
    });
    const [openIdx, setOpenIdx] = useState(null);
    const upd = useCallback(function(k, v) { setS(function(p) { return Object.assign({}, p, { [k]: v }); }); }, []);

    // Indexes built once from window.__momentumData__
    const idx = useMemo(function() {
        try {
            var d = window.__momentumData__;
            if (!d || !d.prices || !d.prices.length) return null;
            return buildIndexes(d.prices, d.dividends || null);
        } catch (e) {
            console.error('[MomentumApp] buildIndexes error:', e);
            return { _error: e.message || String(e) };
        }
    }, []);

    // Phase 1: recompute matrix when heavy params change
    const matrix = useMemo(function() {
        if (!idx || idx._error) return null;
        try {
            return buildMatrix(idx, s);
        } catch (e) {
            console.error('[MomentumApp] buildMatrix error:', e);
            return null;
        }
    }, [idx, s.lookbackPeriod, s.skipWeeks, s.useDividends, s.useVolFilter, s.maxVol, s.useRiskAdj]);

    // Phase 2: build portfolio from matrix (cheap)
    const result = useMemo(function() {
        if (!idx || idx._error || !matrix) return null;
        try {
            return buildPortfolio(idx, matrix, s);
        } catch (e) {
            console.error('[MomentumApp] buildPortfolio error:', e);
            return { error: 'Ошибка расчёта: ' + (e.message || String(e)) };
        }
    }, [idx, matrix, s.holdingPeriod, s.topN, s.useReturnFilter, s.minReturn, s.maxReturn]);

    if (!idx) {
        var noData = window.__momentumData__;
        if (!noData || !noData.prices) {
            return html`<div className="ms-error"><p>Excel файл не настроен или не содержит данных. Перейдите в Настройки → Momentum Week.</p></div>`;
        }
        return html`<div className="ms-error"><p>Ошибка инициализации данных. Подробности в консоли браузера.</p></div>`;
    }
    if (idx._error) return html`<div className="ms-error"><p>Ошибка загрузки данных: ${idx._error}</p></div>`;
    if (!result) return html`<div className="ms-loading"><div className="ms-spinner"></div><p>Расчёт...</p></div>`;
    if (result.error) return html`<div className="ms-error"><p>${result.error}</p></div>`;

    const { portfolioValues, detailedTrades, currentRecommendations, metrics, tipMetrics } = result;
    const tips = getTips(tipMetrics, s);

    return html`
        <${Fragment}>

            <div className="ms-header">
                <p className="ms-subtitle">Российский рынок акций</p>
                <div className="ms-stats">
                    ${idx.n} недель • ${idx.m} тикеров (сейчас торгуется ${idx.activeTickers})
                </div>
            </div>

            <div className="ms-controls">
                <${Slider} id="ms-lookback"
                    label="Период расчета momentum (нед)"
                    value=${s.lookbackPeriod} min=${1} max=${52}
                    unit="нед"
                    desc="За какой период считаем доходность для ранжирования акций"
                    onChange=${function(v) { upd('lookbackPeriod', v); }}
                    locked=${locks.lookback} />
                <${Slider} id="ms-holding"
                    label="Период удержания (нед)"
                    value=${s.holdingPeriod} min=${1} max=${10}
                    unit="нед"
                    desc="Как долго держим позиции перед ребалансировкой"
                    onChange=${function(v) { upd('holdingPeriod', v); }}
                    locked=${locks.holding} />
                <${Slider} id="ms-topn"
                    label="Количество акций в портфеле"
                    value=${s.topN} min=${5} max=${30}
                    unit="акций"
                    desc="Топ N акций с наибольшим momentum"
                    onChange=${function(v) { upd('topN', v); }}
                    locked=${locks.topn} />
            </div>

            <div className="ms-options">
                <div className="ms-option-row">

                    <div className=${'ms-option' + (locks.dividends ? ' ms-option-locked' : '')}>
                        <div className="ms-option-header">
                            <div>
                                <h4>Учет дивидендов</h4>
                                <p>${s.useDividends
                                    ? 'Полная доходность: рост цены + дивиденды'
                                    : 'Только рост цены (без дивидендов)'}</p>
                            </div>
                            <${Toggle} value=${s.useDividends}
                                onChange=${function(v) { upd('useDividends', v); }}
                                locked=${locks.dividends} />
                        </div>
                    </div>

                    <div className=${'ms-option' + (locks.skip ? ' ms-option-locked' : '')}>
                        <div className="ms-option-header">
                            <div>
                                <h4>Reversal Effect: пропустить N последних недель</h4>
                                <p>Исключает последние N недель из расчета momentum. 0 = выключено, 4 ≈ 1 месяц.</p>
                            </div>
                        </div>
                        <div className="ms-option-body" style="display: block;">
                            <label>Пропустить: <span>${s.skipWeeks === 0 ? 'Выкл' : s.skipWeeks + ' нед'}</span></label>
                            <input type="range" min=${0} max=${4} step=${1} value=${s.skipWeeks}
                                onInput=${locks.skip ? undefined : function(e) { upd('skipWeeks', parseInt(e.target.value)); }}
                                disabled=${locks.skip || undefined} />
                        </div>
                    </div>

                </div>
                <div className="ms-option-row">

                    <div className=${'ms-option ms-option-advanced' + (locks.vol ? ' ms-option-locked' : '')}>
                        <div className="ms-option-header">
                            <h4>Фильтр волатильности</h4>
                            <${Toggle} value=${s.useVolFilter}
                                onChange=${function(v) { upd('useVolFilter', v); }}
                                locked=${locks.vol} />
                        </div>
                        ${s.useVolFilter && html`
                            <div className="ms-option-body">
                                <label>Макс. волатильность: <span>${s.maxVol}</span>%</label>
                                <input type="range" min=${20} max=${100} step=${1} value=${s.maxVol}
                                    onInput=${locks.vol ? undefined : function(e) { upd('maxVol', parseInt(e.target.value)); }}
                                    disabled=${locks.vol || undefined} />
                                <p>Исключает акции с волатильностью выше порога</p>
                            </div>
                        `}
                        <div className=${'ms-option-sub' + (locks.riskadj ? ' ms-option-locked' : '')}>
                            <span>Риск-корректированный momentum</span>
                            <${Toggle} value=${s.useRiskAdj}
                                onChange=${function(v) { upd('useRiskAdj', v); }}
                                locked=${locks.riskadj} small=${true} />
                        </div>
                    </div>

                    <div className=${'ms-option ms-option-advanced' + (locks.ret ? ' ms-option-locked' : '')}>
                        <div className="ms-option-header">
                            <h4>Фильтр границ доходности</h4>
                            <${Toggle} value=${s.useReturnFilter}
                                onChange=${function(v) { upd('useReturnFilter', v); }}
                                locked=${locks.ret} />
                        </div>
                        ${s.useReturnFilter && html`
                            <div className="ms-option-body">
                                <label>Мин. доходность: <span>${s.minReturn}</span>%</label>
                                <input type="range" min=${-50} max=${100} step=${5} value=${s.minReturn}
                                    onInput=${locks.ret ? undefined : function(e) { upd('minReturn', parseInt(e.target.value)); }}
                                    disabled=${locks.ret || undefined} />
                                <label style="margin-top:8px;">Макс. доходность: <span>${s.maxReturn}</span>%</label>
                                <input type="range" min=${50} max=${300} step=${10} value=${s.maxReturn}
                                    onInput=${locks.ret ? undefined : function(e) { upd('maxReturn', parseInt(e.target.value)); }}
                                    disabled=${locks.ret || undefined} />
                                <p>Исключает акции за пределами доходности. Оптимум: от +30% до 160%.</p>
                            </div>
                        `}
                    </div>

                </div>
            </div>

            <div className="ms-metrics">
                <div className="ms-metric ms-metric-primary">
                    <span className="ms-metric-label">Общая доходность</span>
                    <span className="ms-metric-value">${metrics.totalReturn}%</span>
                </div>
                <div className="ms-metric ms-metric-primary">
                    <span className="ms-metric-label">Годовая доходность</span>
                    <span className="ms-metric-value">${metrics.annualReturn}%</span>
                </div>
                <div className="ms-metric ms-metric-primary">
                    <span className="ms-metric-label">Коэф. Шарпа</span>
                    <span className="ms-metric-value">${metrics.sharpeRatio}</span>
                </div>
                <div className="ms-metric ms-metric-primary">
                    <span className="ms-metric-label">Коэф. Сортино</span>
                    <span className="ms-metric-value">${metrics.sortinoRatio}</span>
                </div>
                <div className="ms-metric ms-metric-primary">
                    <span className="ms-metric-label">Макс. просадка</span>
                    <span className="ms-metric-value">${metrics.maxDrawdown}%</span>
                </div>
            </div>

            <div className="ms-metrics-secondary">
                <div className="ms-metric">
                    <span className="ms-metric-label">Средняя доходность периода</span>
                    <span className="ms-metric-value">${metrics.avgReturn}%</span>
                </div>
                <div className="ms-metric">
                    <span className="ms-metric-label">Волатильность</span>
                    <span className="ms-metric-value">${metrics.volatility}%</span>
                </div>
                <div className="ms-metric">
                    <span className="ms-metric-label">Количество сделок</span>
                    <span className="ms-metric-value">${metrics.trades} за ${metrics.years} лет</span>
                </div>
            </div>

            <div className="ms-charts">
                <div className="ms-chart-container">
                    <h3>Кривая капитала</h3>
                    <${EquityChart} pvs=${portfolioValues} />
                </div>
                <div className="ms-chart-container">
                    <h3>Распределение доходности периодов</h3>
                    <${ReturnsChart} pvs=${portfolioValues} />
                </div>
            </div>

            ${currentRecommendations && html`
                <div className="ms-recommendations">
                    <div className="ms-recommendations-header">
                        <div>
                            <h3>Текущие рекомендации</h3>
                            <p>Акции для покупки на ${currentRecommendations.date}</p>
                        </div>
                        <div className="ms-recommendations-info">
                            <div>
                                <span className="ms-label">Размер портфеля</span>
                                <span className="ms-value">${currentRecommendations.portfolioSize}</span>
                            </div>
                        </div>
                    </div>
                    <div className="ms-stocks-grid">
                        ${currentRecommendations.stocks.map(function(stock) {
                            return html`
                                <div key=${stock.ticker} className="ms-stock-card">
                                    <div className="ms-stock-header">
                                        <div>
                                            <span className="ms-stock-ticker">${stock.ticker}</span>
                                            <span className="ms-stock-weight">Вес: ${stock.weight}%</span>
                                        </div>
                                        <div className="ms-stock-price">${stock.price} руб</div>
                                    </div>
                                    <div className="ms-stock-details">
                                        <div className="ms-stock-row">
                                            <span>Доходность:</span>
                                            <span className="ms-positive">${stock.rawReturn}%</span>
                                        </div>
                                        <div className="ms-stock-row">
                                            <span>${s.useRiskAdj ? 'Риск-скор:' : 'Momentum:'}</span>
                                            <span className="ms-blue">${s.useRiskAdj ? stock.momentum : stock.momentum + '%'}</span>
                                        </div>
                                        <div className="ms-stock-row">
                                            <span>Волатильность:</span>
                                            <span className=${parseFloat(stock.volatility) > 40 ? 'high-vol' : ''}>${stock.volatility}%</span>
                                        </div>
                                    </div>
                                    <div className="ms-stock-rank">
                                        <span>Ранг</span>
                                        <strong>#${stock.rank}</strong>
                                    </div>
                                </div>
                            `;
                        })}
                    </div>
                    <div className="ms-recommendations-tip">
                        <p>Совет: Распределите капитал равными долями между всеми акциями.</p>
                    </div>
                </div>
            `}

            <div className="ms-history">
                <h3>История сделок</h3>
                <p className="ms-history-desc">Кликните на период, чтобы увидеть детали по каждой акции</p>
                <table className="ms-history-table">
                    <thead>
                        <tr>
                            <th>Дата покупки</th>
                            <th>Дата продажи</th>
                            <th>Акций</th>
                            <th>Доходность</th>
                            <th>Детали</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${detailedTrades.map(function(trade, ti) {
                            const isOpen = openIdx === ti;
                            const retCls = parseFloat(trade.totalReturn) >= 0 ? 'ms-positive' : 'ms-negative';
                            return html`
                                <${Fragment} key=${ti}>
                                    <tr className="ms-history-row"
                                        onClick=${function() { setOpenIdx(isOpen ? null : ti); }}>
                                        <td>${trade.date}</td>
                                        <td>${trade.sellDate}</td>
                                        <td>${trade.stockCount}</td>
                                        <td className=${retCls}>${trade.totalReturn}%</td>
                                        <td>
                                            <button className="ms-details-btn"
                                                onClick=${function(e) { e.stopPropagation(); setOpenIdx(isOpen ? null : ti); }}>
                                                ${isOpen ? 'Скрыть' : 'Показать'}
                                            </button>
                                        </td>
                                    </tr>
                                    ${isOpen && html`
                                        <tr className="ms-history-details">
                                            <td colSpan=${5}>
                                                <div className="ms-details-grid">
                                                    ${trade.stocks.map(function(st, si) {
                                                        const sCls = parseFloat(st.return) >= 0 ? 'ms-positive' : 'ms-negative';
                                                        return html`
                                                            <div key=${si} className="ms-detail-card">
                                                                <div className="ms-detail-header">
                                                                    <span className="ms-detail-ticker">${st.ticker}</span>
                                                                    <span className=${sCls}>${st.return}%</span>
                                                                </div>
                                                                <div className="ms-detail-body">
                                                                    <div>Покупка: ${st.buyPrice} руб</div>
                                                                    <div>Продажа: ${st.sellPrice} руб</div>
                                                                    <div>Вес: ${st.weight}%</div>
                                                                    <div>Momentum: ${(st.momentum * 100).toFixed(2)}%</div>
                                                                </div>
                                                            </div>
                                                        `;
                                                    })}
                                                </div>
                                            </td>
                                        </tr>
                                    `}
                                <//>
                            `;
                        })}
                    </tbody>
                </table>
            </div>

            ${tips.length > 0 && html`
                <div className="ms-tips">
                    <h3>Рекомендации</h3>
                    ${tips.map(function(tip, ti) {
                        return html`<p key=${ti}>${tip}</p>`;
                    })}
                </div>
            `}

        <//>
    `;
}

// ─── Mount ─────────────────────────────────────────────────────────────────────────────

function momentumMount() {
    try {
        var el = document.getElementById('momentum-screener-root');
        if (!el) return;
        // Always mount — MomentumApp handles the no-data error state itself
        ReactDOM.createRoot(el).render(createElement(MomentumApp, null));
    } catch (e) {
        console.error('[MomentumApp] mount error:', e);
        var root = document.getElementById('momentum-screener-root');
        if (root) root.innerHTML = '<div class="ms-error"><p>Ошибка инициализации: ' + (e.message || String(e)) + '</p></div>';
    }
}

// WP footer scripts run before DOMContentLoaded fires in most setups,
// but use readyState as a safety net in case the event already fired.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', momentumMount);
} else {
    momentumMount();
}

})();
