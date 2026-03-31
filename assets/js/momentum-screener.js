/**
 * Momentum Screener for WordPress
 * Russian Stock Market Momentum Strategy Optimizer
 */

(function($) {
    'use strict';

    // State
    let tickersCache = null;
    let charts = {};
    let recalculateTimeout = null;

    // Web Worker
    let worker = null;
    let workerReady = false;
    let currentCalcId = 0;

    // Lock flags
    let locks = {
        lookback: false, holding: false, topn: false,
        dividends: false, skip: false, vol: false,
        riskadj: false, return: false
    };

    // Settings
    let settings = {
        lookbackPeriod: 13, holdingPeriod: 4, topN: 10,
        useDividends: true, skipWeeks: 4,
        useVolFilter: false, maxVol: 50,
        useRiskAdj: false,
        useReturnFilter: false, minReturn: 30, maxReturn: 160
    };

    // ─── Init ───────────────────────────────────────────────────────────────

    function init() {
        const $app = $('#momentum-screener-app');
        if (!$app.length) return;

        settings.lookbackPeriod = parseInt($app.data('lookback')) || momentumScreener.defaults.lookback;
        settings.holdingPeriod  = parseInt($app.data('holding')) || momentumScreener.defaults.holding;
        settings.topN           = parseInt($app.data('topn'))    || momentumScreener.defaults.topn;

        locks.lookback  = $app.data('lock-lookback')  === 1 || $app.data('lock-lookback')  === '1';
        locks.holding   = $app.data('lock-holding')   === 1 || $app.data('lock-holding')   === '1';
        locks.topn      = $app.data('lock-topn')      === 1 || $app.data('lock-topn')      === '1';
        locks.dividends = $app.data('lock-dividends') === 1 || $app.data('lock-dividends') === '1';
        locks.skip      = $app.data('lock-skip')      === 1 || $app.data('lock-skip')      === '1';
        locks.vol       = $app.data('lock-vol')       === 1 || $app.data('lock-vol')       === '1';
        locks.riskadj   = $app.data('lock-riskadj')   === 1 || $app.data('lock-riskadj')   === '1';
        locks.return    = $app.data('lock-return')    === 1 || $app.data('lock-return')    === '1';

        $('#ms-lookback').val(settings.lookbackPeriod);
        $('#ms-holding').val(settings.holdingPeriod);
        $('#ms-topn').val(settings.topN);
        $('#ms-skip-weeks').val(settings.skipWeeks);
        $('#ms-skip-weeks-value').text(settings.skipWeeks === 0 ? 'Выкл' : settings.skipWeeks + ' нед');

        bindEvents();
        fetchData();
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    function bindEvents() {
        if (!locks.lookback) {
            $('#ms-lookback').on('input', function() {
                settings.lookbackPeriod = parseInt($(this).val());
                $('#ms-lookback-value').text(settings.lookbackPeriod + ' нед');
                debouncedRecalculate();
            });
        }
        if (!locks.holding) {
            $('#ms-holding').on('input', function() {
                settings.holdingPeriod = parseInt($(this).val());
                $('#ms-holding-value').text(settings.holdingPeriod + ' нед');
                debouncedRecalculate();
            });
        }
        if (!locks.topn) {
            $('#ms-topn').on('input', function() {
                settings.topN = parseInt($(this).val());
                $('#ms-topn-value').text(settings.topN + ' акций');
                debouncedRecalculate();
            });
        }
        if (!locks.vol) {
            $('#ms-maxvol').on('input', function() {
                settings.maxVol = parseInt($(this).val());
                $('#ms-maxvol-value').text(settings.maxVol);
                debouncedRecalculate();
            });
        }
        if (!locks.return) {
            $('#ms-minreturn').on('input', function() {
                settings.minReturn = parseInt($(this).val());
                $('#ms-minreturn-value').text(settings.minReturn);
                debouncedRecalculate();
            });
            $('#ms-maxreturn').on('input', function() {
                settings.maxReturn = parseInt($(this).val());
                $('#ms-maxreturn-value').text(settings.maxReturn);
                debouncedRecalculate();
            });
        }
        if (!locks.dividends) {
            $('#ms-dividends-toggle').on('click', function() {
                settings.useDividends = !settings.useDividends;
                updateToggle($(this), settings.useDividends);
                $('#ms-dividends-desc').text(settings.useDividends
                    ? 'Полная доходность: рост цены + дивиденды'
                    : 'Только рост цены (без дивидендов)');
                debouncedRecalculate();
            });
        }
        if (!locks.skip) {
            $('#ms-skip-weeks').on('input', function() {
                settings.skipWeeks = parseInt($(this).val());
                $('#ms-skip-weeks-value').text(settings.skipWeeks === 0 ? 'Выкл' : settings.skipWeeks + ' нед');
                debouncedRecalculate();
            });
        }
        if (!locks.vol) {
            $('#ms-volfilter-toggle').on('click', function() {
                settings.useVolFilter = !settings.useVolFilter;
                updateToggle($(this), settings.useVolFilter);
                $('#ms-volfilter-body').toggle(settings.useVolFilter);
                debouncedRecalculate();
            });
        }
        if (!locks.riskadj) {
            $('#ms-riskadj-toggle').on('click', function() {
                settings.useRiskAdj = !settings.useRiskAdj;
                updateToggle($(this), settings.useRiskAdj, true);
                debouncedRecalculate();
            });
        }
        if (!locks.return) {
            $('#ms-returnfilter-toggle').on('click', function() {
                settings.useReturnFilter = !settings.useReturnFilter;
                updateToggle($(this), settings.useReturnFilter);
                $('#ms-returnfilter-body').toggle(settings.useReturnFilter);
                debouncedRecalculate();
            });
        }
    }

    function updateToggle($btn, enabled, small) {
        $btn.toggleClass('active', enabled)
            .text(enabled ? (small ? 'ВКЛ' : 'Включено') : (small ? 'ВЫКЛ' : 'Выключено'))
            .data('enabled', enabled);
    }

    // ─── Data fetching ───────────────────────────────────────────────────────

    function fetchData() {
        $('#ms-loading').show();
        $('#ms-error').hide();
        $('#ms-content').hide();

        if (!momentumScreener.excelUrl) {
            $('#ms-loading').hide();
            showError(momentumScreener.strings.noFile);
            return;
        }

        fetch(momentumScreener.excelUrl)
            .then(r => {
                if (!r.ok) throw new Error('Ошибка загрузки файла');
                return r.arrayBuffer();
            })
            .then(buffer => {
                let priceData, dividendData;
                try {
                    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
                    if (!wb.SheetNames.includes('цены')) {
                        throw new Error('Лист "цены" не найден. Доступные листы: ' + wb.SheetNames.join(', '));
                    }
                    priceData = XLSX.utils.sheet_to_json(wb.Sheets['цены'], { defval: null });
                    if (!priceData || priceData.length === 0) throw new Error('Файл пуст');

                    const divName = ['Дивид','дивиденды','Дивиденды','dividends']
                        .find(n => wb.SheetNames.includes(n));
                    dividendData = divName
                        ? XLSX.utils.sheet_to_json(wb.Sheets[divName], { defval: null })
                        : null;
                } catch (err) {
                    $('#ms-loading').hide();
                    showError(err.message);
                    return;
                }

                finishLoading(priceData, dividendData);
            })
            .catch(err => {
                $('#ms-loading').hide();
                showError(err.message || 'Ошибка загрузки данных');
            });
    }

    /**
     * Pack row-oriented JS objects into column-major Float64Arrays.
     * These can be transferred to the worker in O(1) (zero-copy).
     */
    function packData(priceData, dividendData, tickers) {
        const n = priceData.length;
        const m = tickers.length;

        // column-major: [tickerIdx * n + timeIdx]
        const pricesFlat = new Float64Array(n * m);
        for (let ti = 0; ti < m; ti++) {
            const ticker = tickers[ti];
            const base   = ti * n;
            for (let i = 0; i < n; i++) {
                const v = priceData[i][ticker];
                pricesFlat[base + i] = (v && v > 0) ? v : NaN;
            }
        }

        let divsFlat = null;
        if (dividendData) {
            divsFlat = new Float64Array(n * m);
            for (let ti = 0; ti < m; ti++) {
                const ticker = tickers[ti];
                const base   = ti * n;
                for (let i = 0; i < n && i < dividendData.length; i++) {
                    const row = dividendData[i];
                    divsFlat[base + i] = (row && row[ticker]) ? row[ticker] : 0;
                }
            }
        }

        const dateInts = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            dateInts[i] = new Date(priceData[i].Time).getTime();
        }

        return { pricesFlat, divsFlat, dateInts, n, m };
    }

    function finishLoading(priceData, dividendData) {
        $('#ms-loading').hide();

        tickersCache = Object.keys(priceData[0]).filter(k => k !== 'Time');

        // Compute stats while priceData is still available
        const lastRow     = priceData[priceData.length - 1];
        const activeCount = tickersCache.filter(k => lastRow[k] != null && lastRow[k] !== '').length;
        $('#ms-stats').html(
            priceData.length + ' недель &bull; ' +
            tickersCache.length + ' тикеров (сейчас торгуется ' + activeCount + ')'
        );

        $('#ms-content').show();

        if (typeof Worker === 'undefined' || !momentumScreener.workerUrl) {
            showError('Ваш браузер не поддерживает Web Workers. Обновите браузер.');
            return;
        }

        // Convert to typed arrays — fast, avoids huge structured clone in postMessage
        const packed = packData(priceData, dividendData, tickersCache);

        // priceData and dividendData are no longer needed — free them
        priceData    = null;
        dividendData = null;

        setupWorker(packed);
    }

    // ─── Worker management ───────────────────────────────────────────────────

    function setupWorker(packed) {
        if (worker) worker.terminate();

        worker      = new Worker(momentumScreener.workerUrl);
        workerReady = false;

        worker.onmessage = function(e) {
            const msg = e.data;
            if (msg.type === 'ready') {
                workerReady = true;
                sendToWorker();  // kick off first calculation
            } else if (msg.type === 'result') {
                if (msg.id !== currentCalcId) return;  // stale
                setLoadingState(false);
                if (msg.error) { showError(msg.error); return; }
                $('#ms-error').hide();
                updateMetrics(msg.metrics);
                updateCharts(msg.portfolioValues);
                updateRecommendations(msg.currentRecommendations);
                updateHistory(msg.detailedTrades);
                updateTips(msg.tipMetrics);
            }
        };

        worker.onerror = function(e) {
            setLoadingState(false);
            showError('Ошибка воркера: ' + (e.message || 'проверьте консоль браузера'));
        };

        // Build transfer list — buffers move to worker with zero copy
        const transferList = [packed.pricesFlat.buffer, packed.dateInts.buffer];
        if (packed.divsFlat) transferList.push(packed.divsFlat.buffer);

        worker.postMessage({
            type:      'init',
            pricesFlat: packed.pricesFlat,
            divsFlat:   packed.divsFlat,
            dateInts:   packed.dateInts,
            tickersCache,
            n: packed.n,
            m: packed.m
        }, transferList);
    }

    function sendToWorker() {
        if (!worker || !workerReady) return;
        currentCalcId++;
        worker.postMessage({
            type:     'recalculate',
            settings: Object.assign({}, settings),
            id:       currentCalcId
        });
    }

    function debouncedRecalculate() {
        clearTimeout(recalculateTimeout);
        setLoadingState(true);
        recalculateTimeout = setTimeout(sendToWorker, 500);
    }

    function setLoadingState(loading) {
        $('#ms-metrics').css('opacity', loading ? '0.5' : '1');
    }

    function showError(message) {
        $('#ms-error').show().find('p').text(message);
    }

    // ─── UI updates ──────────────────────────────────────────────────────────

    function updateMetrics(metrics) {
        $('#ms-total-return').text(metrics.totalReturn + '%');
        $('#ms-annual-return').text(metrics.annualReturn + '%');
        $('#ms-sharpe').text(metrics.sharpeRatio);
        $('#ms-sortino').text(metrics.sortinoRatio);
        $('#ms-drawdown').text(metrics.maxDrawdown + '%');
        $('#ms-avg-return').text(metrics.avgReturn + '%');
        $('#ms-volatility').text(metrics.volatility + '%');
        $('#ms-trades').text(metrics.trades + ' за ' + metrics.years + ' лет');
    }

    function updateCharts(portfolioValues) {
        const labels     = portfolioValues.map(v => v.date);
        const equityData = portfolioValues.map(v => v.value);

        if (charts.equity) {
            charts.equity.data.labels = labels;
            charts.equity.data.datasets[0].data = equityData;
            charts.equity.update('none');
        } else {
            const ctx = document.getElementById('ms-equity-chart').getContext('2d');
            charts.equity = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{ label: 'Стоимость портфеля (руб)', data: equityData,
                        borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)',
                        fill: true, tension: 0.1 }]
                },
                options: { responsive: true, animation: false,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: false } } }
            });
        }

        const recent       = portfolioValues.slice(-50);
        const recentLabels = recent.map(v => v.date);
        const returnData   = recent.map(v => v.return);
        const colors       = recent.map(v =>
            v.return >= 0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)'
        );

        if (charts.returns) {
            charts.returns.data.labels = recentLabels;
            charts.returns.data.datasets[0].data = returnData;
            charts.returns.data.datasets[0].backgroundColor = colors;
            charts.returns.update('none');
        } else {
            const ctx = document.getElementById('ms-returns-chart').getContext('2d');
            charts.returns = new Chart(ctx, {
                type: 'bar',
                data: { labels: recentLabels,
                    datasets: [{ label: 'Доходность периода (%)', data: returnData, backgroundColor: colors }] },
                options: { responsive: true, animation: false,
                    plugins: { legend: { position: 'top' } } }
            });
        }
    }

    function updateRecommendations(recs) {
        if (!recs) return;
        $('#ms-recommendations-date').text('Акции для покупки на ' + recs.date);
        $('#ms-portfolio-size').text(recs.portfolioSize);

        const $grid = $('#ms-stocks-grid').empty();
        recs.stocks.forEach(stock => {
            const volClass = parseFloat(stock.volatility) > 40 ? 'high-vol' : '';
            $grid.append(`
                <div class="ms-stock-card">
                    <div class="ms-stock-header">
                        <div>
                            <span class="ms-stock-ticker">${stock.ticker}</span>
                            <span class="ms-stock-weight">Вес: ${stock.weight}%</span>
                        </div>
                        <div class="ms-stock-price">${stock.price} руб</div>
                    </div>
                    <div class="ms-stock-details">
                        <div class="ms-stock-row"><span>Доходность:</span>
                            <span class="ms-positive">${stock.rawReturn}%</span></div>
                        <div class="ms-stock-row">
                            <span>${settings.useRiskAdj ? 'Риск-скор:' : 'Momentum:'}</span>
                            <span class="ms-blue">${settings.useRiskAdj ? stock.momentum : stock.momentum + '%'}</span>
                        </div>
                        <div class="ms-stock-row"><span>Волатильность:</span>
                            <span class="${volClass}">${stock.volatility}%</span></div>
                    </div>
                    <div class="ms-stock-rank"><span>Ранг</span><strong>#${stock.rank}</strong></div>
                </div>`);
        });
    }

    function updateHistory(trades) {
        const $tbody = $('#ms-history-body').empty();
        trades.forEach((trade, idx) => {
            const rc = parseFloat(trade.totalReturn) >= 0 ? 'ms-positive' : 'ms-negative';
            $tbody.append(`
                <tr class="ms-history-row" data-idx="${idx}">
                    <td>${trade.date}</td><td>${trade.sellDate}</td>
                    <td>${trade.stockCount}</td>
                    <td class="${rc}">${trade.totalReturn}%</td>
                    <td><button class="ms-details-btn">Показать</button></td>
                </tr>
                <tr class="ms-history-details" id="ms-details-${idx}" style="display:none;">
                    <td colspan="5"><div class="ms-details-grid">
                        ${trade.stocks.map(s => `
                            <div class="ms-detail-card">
                                <div class="ms-detail-header">
                                    <span class="ms-detail-ticker">${s.ticker}</span>
                                    <span class="${parseFloat(s.return) >= 0 ? 'ms-positive' : 'ms-negative'}">${s.return}%</span>
                                </div>
                                <div class="ms-detail-body">
                                    <div>Покупка: ${s.buyPrice} руб</div>
                                    <div>Продажа: ${s.sellPrice} руб</div>
                                    <div>Вес: ${s.weight}%</div>
                                    <div>Momentum: ${(s.momentum * 100).toFixed(2)}%</div>
                                </div>
                            </div>`).join('')}
                    </div></td>
                </tr>`);
        });
        $('.ms-details-btn').off('click').on('click', function() {
            const idx = $(this).closest('tr').data('idx');
            const $d  = $('#ms-details-' + idx);
            $d.toggle();
            $(this).text($d.is(':visible') ? 'Скрыть' : 'Показать');
        });
    }

    function updateTips(metrics) {
        const tips = [];
        if (metrics.sharpeRatio > 1)
            tips.push('Отличный коэффициент Шарпа! Стратегия показывает хорошее соотношение доходности и риска.');
        if (metrics.sharpeRatio <= 0.5)
            tips.push('Низкий коэффициент Шарпа. Попробуйте увеличить период расчета momentum или изменить количество акций.');
        if (metrics.sortinoRatio > metrics.sharpeRatio * 1.3)
            tips.push('Коэффициент Сортино значительно выше Шарпа — стратегия хорошо защищена от нисходящих рисков.');
        if (Math.abs(metrics.maxDrawdown) > 30)
            tips.push('Высокая просадка (' + metrics.maxDrawdown.toFixed(2) + '%). Рассмотрите увеличение диверсификации или используйте фильтр волатильности.');
        if (metrics.annualReturn > 15)
            tips.push('Годовая доходность ' + metrics.annualReturn.toFixed(2) + '% превышает исторический рост рынка!');
        if (settings.lookbackPeriod < 13)
            tips.push('Короткий период расчета может привести к высокой волатильности. Попробуйте 13–26 недель.');
        if (settings.topN > 20)
            tips.push('Большое количество акций может снизить эффект momentum. Оптимум — 10–15 акций.');
        if (settings.useVolFilter)
            tips.push('Фильтр волатильности активен — исключаются акции с волатильностью выше ' + settings.maxVol + '%.');
        if (settings.useRiskAdj)
            tips.push('Риск-корректированный momentum учитывает волатильность при выборе акций.');
        if (settings.useReturnFilter)
            tips.push('Фильтр границ доходности активен: от ' + settings.minReturn + '% до ' + settings.maxReturn + '%.');

        const $tips = $('#ms-tips-content').empty();
        tips.forEach(t => $tips.append('<p>' + t + '</p>'));
    }

    $(document).ready(init);

})(jQuery);
