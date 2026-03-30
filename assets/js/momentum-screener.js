/**
 * Momentum Screener for WordPress
 * Russian Stock Market Momentum Strategy Optimizer
 */

(function($) {
    'use strict';

    // State variables
    let priceData = null;
    let dividendData = null;
    let charts = {};
    let recalculateTimeout = null;
    let tickersCache = null;

    // Web Worker state
    let worker = null;
    let workerReady = false;
    let currentCalcId = 0;

    // Lock flags (set from shortcode attributes)
    let locks = {
        lookback: false,
        holding: false,
        topn: false,
        dividends: false,
        skip: false,
        vol: false,
        riskadj: false,
        return: false
    };

    // Settings
    let settings = {
        lookbackPeriod: 13,
        holdingPeriod: 4,
        topN: 10,
        useDividends: true,
        skipWeeks: 4,
        useVolFilter: false,
        maxVol: 50,
        useRiskAdj: false,
        useReturnFilter: false,
        minReturn: 30,
        maxReturn: 160
    };

    /**
     * Initialize the screener
     */
    function init() {
        const $app = $('#momentum-screener-app');
        if (!$app.length) return;

        // Load settings from data attributes
        settings.lookbackPeriod = parseInt($app.data('lookback')) || momentumScreener.defaults.lookback;
        settings.holdingPeriod = parseInt($app.data('holding')) || momentumScreener.defaults.holding;
        settings.topN = parseInt($app.data('topn')) || momentumScreener.defaults.topn;

        // Load lock flags from data attributes
        locks.lookback  = $app.data('lock-lookback')  === 1 || $app.data('lock-lookback')  === '1';
        locks.holding   = $app.data('lock-holding')   === 1 || $app.data('lock-holding')   === '1';
        locks.topn      = $app.data('lock-topn')      === 1 || $app.data('lock-topn')      === '1';
        locks.dividends = $app.data('lock-dividends') === 1 || $app.data('lock-dividends') === '1';
        locks.skip      = $app.data('lock-skip')      === 1 || $app.data('lock-skip')      === '1';
        locks.vol       = $app.data('lock-vol')       === 1 || $app.data('lock-vol')       === '1';
        locks.riskadj   = $app.data('lock-riskadj')   === 1 || $app.data('lock-riskadj')   === '1';
        locks.return    = $app.data('lock-return')    === 1 || $app.data('lock-return')    === '1';

        // Set initial control values
        $('#ms-lookback').val(settings.lookbackPeriod);
        $('#ms-holding').val(settings.holdingPeriod);
        $('#ms-topn').val(settings.topN);
        $('#ms-skip-weeks').val(settings.skipWeeks);
        $('#ms-skip-weeks-value').text(settings.skipWeeks === 0 ? 'Выкл' : settings.skipWeeks + ' нед');

        // Bind events
        bindEvents();

        // Fetch data
        fetchData();
    }

    /**
     * Bind event handlers
     */
    function bindEvents() {
        // Range sliders
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

        // Toggle buttons
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

    /**
     * Update toggle button state
     */
    function updateToggle($btn, enabled, small) {
        if (enabled) {
            $btn.addClass('active').text(small ? 'ВКЛ' : 'Включено');
        } else {
            $btn.removeClass('active').text(small ? 'ВЫКЛ' : 'Выключено');
        }
        $btn.data('enabled', enabled);
    }

    /**
     * Fetch Excel data from URL
     */
    function fetchData() {
        $('#ms-loading').show();
        $('#ms-error').hide();
        $('#ms-content').hide();

        // Check if Excel URL is configured
        if (!momentumScreener.excelUrl) {
            $('#ms-loading').hide();
            showError(momentumScreener.strings.noFile);
            return;
        }

        // Fetch Excel file
        fetch(momentumScreener.excelUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Ошибка загрузки файла');
                }
                return response.arrayBuffer();
            })
            .then(data => {
                try {
                    // Parse Excel with SheetJS
                    const workbook = XLSX.read(data, { type: 'array', cellDates: true });

                    // Check for prices sheet
                    if (!workbook.SheetNames.includes('цены')) {
                        throw new Error('Лист "цены" не найден. Доступные листы: ' + workbook.SheetNames.join(', '));
                    }

                    // Parse prices sheet
                    const sheet = workbook.Sheets['цены'];
                    priceData = XLSX.utils.sheet_to_json(sheet, { defval: null });

                    if (!priceData || priceData.length === 0) {
                        throw new Error('Файл пуст');
                    }

                    // Check for dividends sheet
                    const divSheetNames = ['Дивид', 'дивиденды', 'Дивиденды', 'dividends'];
                    const divSheetName = divSheetNames.find(name => workbook.SheetNames.includes(name));

                    if (divSheetName) {
                        const divSheet = workbook.Sheets[divSheetName];
                        dividendData = XLSX.utils.sheet_to_json(divSheet, { defval: null });
                    } else {
                        dividendData = null;
                    }

                    finishLoading();

                } catch (err) {
                    $('#ms-loading').hide();
                    showError(err.message);
                }
            })
            .catch(error => {
                $('#ms-loading').hide();
                showError(error.message || 'Ошибка загрузки данных');
            });
    }

    /**
     * Finish loading and start calculations
     */
    function finishLoading() {
        $('#ms-loading').hide();
        updateStats();

        // Cache tickers here for the worker
        if (!tickersCache) {
            tickersCache = Object.keys(priceData[0]).filter(k => k !== 'Time');
        }

        $('#ms-content').show();

        if (typeof Worker !== 'undefined' && momentumScreener.workerUrl) {
            setupWorker();
        } else {
            // Fallback: synchronous calculation
            recalculateSynchronous();
        }
    }

    // ─── Web Worker management ──────────────────────────────────────────────

    /**
     * Create and init the worker, then trigger first calculation
     */
    function setupWorker() {
        if (worker) {
            worker.terminate();
        }

        worker = new Worker(momentumScreener.workerUrl);
        workerReady = false;

        worker.onmessage = function(e) {
            const msg = e.data;

            if (msg.type === 'ready') {
                workerReady = true;
                // Kick off first calculation right after init
                sendToWorker();

            } else if (msg.type === 'result') {
                // Ignore stale results from superseded calculations
                if (msg.id !== currentCalcId) return;

                setLoadingState(false);

                if (msg.error) {
                    showError(msg.error);
                    return;
                }

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
            showError('Ошибка вычислений: ' + (e.message || 'неизвестная ошибка'));
        };

        // Send data to worker (only done once)
        worker.postMessage({
            type: 'init',
            priceData: priceData,
            dividendData: dividendData,
            tickersCache: tickersCache
        });
    }

    /**
     * Send current settings to worker for recalculation
     */
    function sendToWorker() {
        if (!worker || !workerReady) return;
        currentCalcId++;
        worker.postMessage({
            type: 'recalculate',
            settings: Object.assign({}, settings),
            id: currentCalcId
        });
    }

    /**
     * Show/hide loading state on metrics panel
     */
    function setLoadingState(loading) {
        $('#ms-metrics').css('opacity', loading ? '0.5' : '1');
    }

    /**
     * Debounced recalculate — cancels pending timeout on rapid changes.
     * The worker ignores results from superseded calculation IDs.
     */
    function debouncedRecalculate() {
        if (recalculateTimeout) {
            clearTimeout(recalculateTimeout);
        }
        setLoadingState(true);
        recalculateTimeout = setTimeout(function() {
            sendToWorker();
        }, 500);
    }

    /**
     * Show error message
     */
    function showError(message) {
        $('#ms-error').show().find('p').text(message);
    }

    /**
     * Update data statistics
     */
    function updateStats() {
        if (!priceData || priceData.length === 0) return;

        // Cache tickers list
        if (!tickersCache) {
            tickersCache = Object.keys(priceData[0]).filter(k => k !== 'Time');
        }

        const lastRow = priceData[priceData.length - 1];
        const activeCount = Object.keys(lastRow).filter(k =>
            k !== 'Time' && lastRow[k] != null && lastRow[k] !== ''
        ).length;

        $('#ms-stats').html(
            priceData.length + ' недель &bull; ' +
            tickersCache.length + ' тикеров (сейчас торгуется ' + activeCount + ')'
        );
    }

    // ─── UI update functions ────────────────────────────────────────────────

    /**
     * Update metrics display
     */
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

    /**
     * Update charts — reuses existing Chart.js instances instead of
     * destroying and recreating them on every recalculation.
     */
    function updateCharts(portfolioValues) {
        const labels = portfolioValues.map(v => v.date);
        const equityData = portfolioValues.map(v => v.value);

        // ── Equity chart ────────────────────────────────────────────────────
        if (charts.equity) {
            charts.equity.data.labels = labels;
            charts.equity.data.datasets[0].data = equityData;
            charts.equity.update('none'); // skip animation for instant update
        } else {
            const equityCtx = document.getElementById('ms-equity-chart').getContext('2d');
            charts.equity = new Chart(equityCtx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Стоимость портфеля (руб)',
                        data: equityData,
                        borderColor: '#3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        fill: true,
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    animation: false,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: false } }
                }
            });
        }

        // ── Returns chart (last 50 periods) ─────────────────────────────────
        const recentValues = portfolioValues.slice(-50);
        const recentLabels = recentValues.map(v => v.date);
        const returnData   = recentValues.map(v => v.return);
        const colors       = recentValues.map(v =>
            v.return >= 0 ? 'rgba(16, 185, 129, 0.7)' : 'rgba(239, 68, 68, 0.7)'
        );

        if (charts.returns) {
            charts.returns.data.labels = recentLabels;
            charts.returns.data.datasets[0].data = returnData;
            charts.returns.data.datasets[0].backgroundColor = colors;
            charts.returns.update('none');
        } else {
            const returnsCtx = document.getElementById('ms-returns-chart').getContext('2d');
            charts.returns = new Chart(returnsCtx, {
                type: 'bar',
                data: {
                    labels: recentLabels,
                    datasets: [{
                        label: 'Доходность периода (%)',
                        data: returnData,
                        backgroundColor: colors
                    }]
                },
                options: {
                    responsive: true,
                    animation: false,
                    plugins: { legend: { position: 'top' } }
                }
            });
        }
    }

    /**
     * Update recommendations
     */
    function updateRecommendations(recs) {
        if (!recs) return;

        $('#ms-recommendations-date').text('Акции для покупки на ' + recs.date);
        $('#ms-portfolio-size').text(recs.portfolioSize);

        const $grid = $('#ms-stocks-grid').empty();

        recs.stocks.forEach(stock => {
            const volClass = parseFloat(stock.volatility) > 40 ? 'high-vol' : '';
            const html = `
                <div class="ms-stock-card">
                    <div class="ms-stock-header">
                        <div>
                            <span class="ms-stock-ticker">${stock.ticker}</span>
                            <span class="ms-stock-weight">Вес: ${stock.weight}%</span>
                        </div>
                        <div class="ms-stock-price">${stock.price} руб</div>
                    </div>
                    <div class="ms-stock-details">
                        <div class="ms-stock-row">
                            <span>Доходность:</span>
                            <span class="ms-positive">${stock.rawReturn}%</span>
                        </div>
                        <div class="ms-stock-row">
                            <span>${settings.useRiskAdj ? 'Риск-скор:' : 'Momentum:'}</span>
                            <span class="ms-blue">${settings.useRiskAdj ? stock.momentum : stock.momentum + '%'}</span>
                        </div>
                        <div class="ms-stock-row">
                            <span>Волатильность:</span>
                            <span class="${volClass}">${stock.volatility}%</span>
                        </div>
                    </div>
                    <div class="ms-stock-rank">
                        <span>Ранг</span>
                        <strong>#${stock.rank}</strong>
                    </div>
                </div>
            `;
            $grid.append(html);
        });
    }

    /**
     * Update trade history
     */
    function updateHistory(trades) {
        const $tbody = $('#ms-history-body').empty();

        trades.forEach((trade, idx) => {
            const returnClass = parseFloat(trade.totalReturn) >= 0 ? 'ms-positive' : 'ms-negative';

            const row = `
                <tr class="ms-history-row" data-idx="${idx}">
                    <td>${trade.date}</td>
                    <td>${trade.sellDate}</td>
                    <td>${trade.stockCount}</td>
                    <td class="${returnClass}">${trade.totalReturn}%</td>
                    <td><button class="ms-details-btn">Показать</button></td>
                </tr>
                <tr class="ms-history-details" id="ms-details-${idx}" style="display: none;">
                    <td colspan="5">
                        <div class="ms-details-grid">
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
                                </div>
                            `).join('')}
                        </div>
                    </td>
                </tr>
            `;
            $tbody.append(row);
        });

        // Bind detail toggle
        $('.ms-details-btn').off('click').on('click', function() {
            const idx = $(this).closest('tr').data('idx');
            const $details = $('#ms-details-' + idx);
            $details.toggle();
            $(this).text($details.is(':visible') ? 'Скрыть' : 'Показать');
        });
    }

    /**
     * Update tips
     */
    function updateTips(metrics) {
        const tips = [];

        if (metrics.sharpeRatio > 1) {
            tips.push('Отличный коэффициент Шарпа! Стратегия показывает хорошее соотношение доходности и риска.');
        }
        if (metrics.sharpeRatio <= 0.5) {
            tips.push('Низкий коэффициент Шарпа. Попробуйте увеличить период расчета momentum или изменить количество акций.');
        }
        if (metrics.sortinoRatio > metrics.sharpeRatio * 1.3) {
            tips.push('Коэффициент Сортино значительно выше Шарпа - стратегия хорошо защищена от нисходящих рисков.');
        }
        if (Math.abs(metrics.maxDrawdown) > 30) {
            tips.push('Высокая просадка (' + metrics.maxDrawdown.toFixed(2) + '%). Рассмотрите увеличение диверсификации или используйте фильтр волатильности.');
        }
        if (metrics.annualReturn > 15) {
            tips.push('Годовая доходность ' + metrics.annualReturn.toFixed(2) + '% превышает исторический рост рынка!');
        }
        if (settings.lookbackPeriod < 13) {
            tips.push('Короткий период расчета может привести к высокой волатильности. Попробуйте 13-26 недель (3-6 месяцев).');
        }
        if (settings.topN > 20) {
            tips.push('Большое количество акций может снизить эффект momentum. Оптимум обычно 10-15 акций.');
        }
        if (settings.useVolFilter) {
            tips.push('Фильтр волатильности активен - исключаются акции с волатильностью выше ' + settings.maxVol + '%.');
        }
        if (settings.useRiskAdj) {
            tips.push('Риск-корректированный momentum учитывает волатильность при выборе акций.');
        }
        if (settings.useReturnFilter) {
            tips.push('Фильтр границ доходности активен: от ' + settings.minReturn + '% до ' + settings.maxReturn + '%. Исключаются перегретые акции и акции без импульса.');
        }

        const $tips = $('#ms-tips-content').empty();
        tips.forEach(tip => {
            $tips.append('<p>' + tip + '</p>');
        });
    }

    // ─── Synchronous fallback (browsers without Worker support) ────────────

    function recalculateSynchronous() {
        if (!priceData || priceData.length === 0) return;

        // Inline helpers (mirrors worker logic)
        function calcVol(prices) {
            if (prices.length < 2) return 0;
            const returns = [];
            for (let i = 1; i < prices.length; i++) {
                if (prices[i] && prices[i-1] && prices[i-1] > 0) {
                    returns.push((prices[i] - prices[i-1]) / prices[i-1]);
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

        function calcMomentumAtIndex(i) {
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
            return { selectedStocks: momentumScores.slice(0, settings.topN), date: currentDate };
        }

        const portfolioValues = [];
        const detailedTrades = [];
        let cash = 100000;
        const startIdx = settings.lookbackPeriod + settings.skipWeeks;

        if (startIdx >= priceData.length - settings.holdingPeriod) {
            showError('Недостаточно данных для расчета. Попробуйте уменьшить период расчета momentum.');
            return;
        }

        for (let i = startIdx; i < priceData.length - settings.holdingPeriod; i += settings.holdingPeriod) {
            const { selectedStocks } = calcMomentumAtIndex(i);
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
            portfolioValues.push({ date: formatDate(currentDate), value: cash, return: periodReturn * 100 });
            detailedTrades.push({
                date: formatDate(currentDate),
                sellDate: formatDate(new Date(priceData[i + settings.holdingPeriod].Time)),
                totalReturn: (periodReturn * 100).toFixed(2),
                stockCount: selectedStocks.length,
                stocks: stockDetails
            });
        }

        if (portfolioValues.length === 0) {
            showError('Недостаточно данных для расчета');
            return;
        }

        $('#ms-error').hide();

        const lastIdx = priceData.length - 1;
        let currentRecommendations = null;
        if (lastIdx >= startIdx) {
            const { selectedStocks, date } = calcMomentumAtIndex(lastIdx);
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

        updateMetrics({
            totalReturn:  totalReturn.toFixed(2),
            annualReturn: annualReturn.toFixed(2),
            avgReturn:    avgReturn.toFixed(2),
            volatility:   volatility.toFixed(2),
            sharpeRatio:  sharpeRatio.toFixed(2),
            sortinoRatio: sortinoRatio.toFixed(2),
            maxDrawdown:  maxDrawdown.toFixed(2),
            trades: detailedTrades.length,
            years:  totalYears.toFixed(1)
        });

        updateCharts(portfolioValues);
        updateRecommendations(currentRecommendations);
        updateHistory(detailedTrades);
        updateTips({ sharpeRatio, sortinoRatio, maxDrawdown, annualReturn });
    }

    // Initialize on document ready
    $(document).ready(init);

})(jQuery);
