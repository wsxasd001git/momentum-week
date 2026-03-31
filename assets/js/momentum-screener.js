/**
 * Momentum Screener for WordPress
 * Main thread is responsible only for UI. All data work runs in the worker.
 */

(function($) {
    'use strict';

    let tickersCache = null;
    let charts       = {};
    let recalcTimeout = null;
    let worker        = null;
    let workerReady   = false;
    let currentCalcId = 0;

    let locks = {
        lookback: false, holding: false, topn: false,
        dividends: false, skip: false, vol: false,
        riskadj: false, return: false
    };

    let settings = {
        lookbackPeriod: 13, holdingPeriod: 4, topN: 10,
        useDividends: true, skipWeeks: 4,
        useVolFilter: false, maxVol: 50,
        useRiskAdj: false,
        useReturnFilter: false, minReturn: 30, maxReturn: 160
    };

    // ─── Init ────────────────────────────────────────────────────────────────

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
        startWorker();
    }

    // ─── Worker ──────────────────────────────────────────────────────────────

    function startWorker() {
        if (typeof Worker === 'undefined' || !momentumScreener.workerUrl) {
            showError('Ваш браузер не поддерживает Web Workers. Обновите браузер.');
            return;
        }

        $('#ms-loading').show();
        $('#ms-error').hide();
        $('#ms-content').hide();

        worker = new Worker(momentumScreener.workerUrl);

        worker.onmessage = function(e) {
            const msg = e.data;

            if (msg.type === 'ready') {
                tickersCache = msg.stats.tickers;
                $('#ms-stats').html(
                    msg.stats.n + ' недель &bull; ' +
                    msg.stats.m + ' тикеров (сейчас торгуется ' + msg.stats.activeTickers + ')'
                );
                workerReady = true;
                $('#ms-loading').hide();
                $('#ms-content').show();
                sendToWorker();

            } else if (msg.type === 'result') {
                if (msg.id !== currentCalcId) return;
                setLoadingState(false);
                if (msg.error) { showError(msg.error); return; }
                $('#ms-error').hide();
                updateMetrics(msg.metrics);
                updateCharts(msg.portfolioValues);
                updateRecommendations(msg.currentRecommendations);
                updateHistory(msg.detailedTrades);
                updateTips(msg.tipMetrics);

            } else if (msg.type === 'error') {
                $('#ms-loading').hide();
                setLoadingState(false);
                showError(msg.message);
            }
        };

        worker.onerror = function(e) {
            $('#ms-loading').hide();
            setLoadingState(false);
            showError('Ошибка воркера: ' + (e.message || 'проверьте консоль браузера'));
        };

        // Tell the worker to fetch + parse everything itself
        worker.postMessage({
            type:       'init',
            excelUrl:   momentumScreener.excelUrl,
            sheetjsUrl: momentumScreener.sheetjsUrl
        });
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
        clearTimeout(recalcTimeout);
        setLoadingState(true);
        recalcTimeout = setTimeout(sendToWorker, 500);
    }

    function setLoadingState(on) {
        $('#ms-metrics').css('opacity', on ? '0.5' : '1');
    }

    function showError(msg) {
        $('#ms-error').show().find('p').text(msg);
    }

    // ─── Events ──────────────────────────────────────────────────────────────

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

    // ─── UI updates ───────────────────────────────────────────────────────────

    function updateMetrics(m) {
        $('#ms-total-return').text(m.totalReturn + '%');
        $('#ms-annual-return').text(m.annualReturn + '%');
        $('#ms-sharpe').text(m.sharpeRatio);
        $('#ms-sortino').text(m.sortinoRatio);
        $('#ms-drawdown').text(m.maxDrawdown + '%');
        $('#ms-avg-return').text(m.avgReturn + '%');
        $('#ms-volatility').text(m.volatility + '%');
        $('#ms-trades').text(m.trades + ' за ' + m.years + ' лет');
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
                data: { labels, datasets: [{
                    label: 'Стоимость портфеля (руб)', data: equityData,
                    borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)',
                    fill: true, tension: 0.1
                }] },
                options: { responsive: true, animation: false,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: false } } }
            });
        }

        const recent       = portfolioValues.slice(-50);
        const recentLabels = recent.map(v => v.date);
        const returnData   = recent.map(v => v.return);
        const colors       = recent.map(v => v.return >= 0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)');

        if (charts.returns) {
            charts.returns.data.labels = recentLabels;
            charts.returns.data.datasets[0].data = returnData;
            charts.returns.data.datasets[0].backgroundColor = colors;
            charts.returns.update('none');
        } else {
            const ctx = document.getElementById('ms-returns-chart').getContext('2d');
            charts.returns = new Chart(ctx, {
                type: 'bar',
                data: { labels: recentLabels, datasets: [{
                    label: 'Доходность периода (%)', data: returnData, backgroundColor: colors
                }] },
                options: { responsive: true, animation: false, plugins: { legend: { position: 'top' } } }
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
