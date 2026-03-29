<?php
/**
 * Shortcode template for Momentum Screener
 */

if (!defined('ABSPATH')) {
    exit;
}
?>

<?php
$lock_lookback  = !empty($atts['lock_lookback'])  && $atts['lock_lookback']  !== '0';
$lock_holding   = !empty($atts['lock_holding'])   && $atts['lock_holding']   !== '0';
$lock_topn      = !empty($atts['lock_topn'])      && $atts['lock_topn']      !== '0';
$lock_dividends = !empty($atts['lock_dividends']) && $atts['lock_dividends'] !== '0';
$lock_skip      = !empty($atts['lock_skip'])      && $atts['lock_skip']      !== '0';
$lock_vol       = !empty($atts['lock_vol'])       && $atts['lock_vol']       !== '0';
$lock_riskadj   = !empty($atts['lock_riskadj'])   && $atts['lock_riskadj']   !== '0';
$lock_return    = !empty($atts['lock_return'])    && $atts['lock_return']    !== '0';
?>
<div id="momentum-screener-app" class="momentum-screener-container"
     data-lookback="<?php echo esc_attr($atts['lookback']); ?>"
     data-holding="<?php echo esc_attr($atts['holding']); ?>"
     data-topn="<?php echo esc_attr($atts['topn']); ?>"
     data-lock-lookback="<?php echo $lock_lookback ? '1' : '0'; ?>"
     data-lock-holding="<?php echo $lock_holding ? '1' : '0'; ?>"
     data-lock-topn="<?php echo $lock_topn ? '1' : '0'; ?>"
     data-lock-dividends="<?php echo $lock_dividends ? '1' : '0'; ?>"
     data-lock-skip="<?php echo $lock_skip ? '1' : '0'; ?>"
     data-lock-vol="<?php echo $lock_vol ? '1' : '0'; ?>"
     data-lock-riskadj="<?php echo $lock_riskadj ? '1' : '0'; ?>"
     data-lock-return="<?php echo $lock_return ? '1' : '0'; ?>">

    <!-- Header -->
    <div class="ms-header">
        <p class="ms-subtitle"><?php esc_html_e('Российский рынок акций', 'momentum-screener'); ?></p>
        <div class="ms-stats" id="ms-stats"></div>
    </div>

    <!-- Loading indicator -->
    <div class="ms-loading" id="ms-loading">
        <div class="ms-spinner"></div>
        <p><?php esc_html_e('Загрузка данных...', 'momentum-screener'); ?></p>
    </div>

    <!-- Error message -->
    <div class="ms-error" id="ms-error" style="display: none;">
        <p></p>
    </div>

    <!-- Main content -->
    <div class="ms-content" id="ms-content" style="display: none;">

        <!-- Controls -->
        <div class="ms-controls">
            <div class="ms-control-group<?php echo $lock_lookback ? ' ms-control-locked' : ''; ?>">
                <label for="ms-lookback"><?php esc_html_e('Период расчета momentum (нед)', 'momentum-screener'); ?></label>
                <input type="range" id="ms-lookback" min="1" max="52" value="<?php echo esc_attr($atts['lookback']); ?>"<?php echo $lock_lookback ? ' disabled' : ''; ?>>
                <span class="ms-control-value" id="ms-lookback-value"><?php echo esc_html($atts['lookback']); ?> нед</span>
                <p class="ms-control-desc"><?php esc_html_e('За какой период считаем доходность для ранжирования акций', 'momentum-screener'); ?></p>
            </div>

            <div class="ms-control-group<?php echo $lock_holding ? ' ms-control-locked' : ''; ?>">
                <label for="ms-holding"><?php esc_html_e('Период удержания (нед)', 'momentum-screener'); ?></label>
                <input type="range" id="ms-holding" min="1" max="10" value="<?php echo esc_attr($atts['holding']); ?>"<?php echo $lock_holding ? ' disabled' : ''; ?>>
                <span class="ms-control-value" id="ms-holding-value"><?php echo esc_html($atts['holding']); ?> нед</span>
                <p class="ms-control-desc"><?php esc_html_e('Как долго держим позиции перед ребалансировкой', 'momentum-screener'); ?></p>
            </div>

            <div class="ms-control-group<?php echo $lock_topn ? ' ms-control-locked' : ''; ?>">
                <label for="ms-topn"><?php esc_html_e('Количество акций в портфеле', 'momentum-screener'); ?></label>
                <input type="range" id="ms-topn" min="5" max="30" value="<?php echo esc_attr($atts['topn']); ?>"<?php echo $lock_topn ? ' disabled' : ''; ?>>
                <span class="ms-control-value" id="ms-topn-value"><?php echo esc_html($atts['topn']); ?> акций</span>
                <p class="ms-control-desc"><?php esc_html_e('Топ N акций с наибольшим momentum', 'momentum-screener'); ?></p>
            </div>
        </div>

        <!-- Options -->
        <div class="ms-options">
            <div class="ms-option-row">
                <div class="ms-option<?php echo $lock_dividends ? ' ms-option-locked' : ''; ?>">
                    <div class="ms-option-header">
                        <div>
                            <h4><?php esc_html_e('Учет дивидендов', 'momentum-screener'); ?></h4>
                            <p id="ms-dividends-desc"><?php esc_html_e('Полная доходность: рост цены + дивиденды', 'momentum-screener'); ?></p>
                        </div>
                        <button class="ms-toggle active<?php echo $lock_dividends ? ' ms-locked' : ''; ?>" id="ms-dividends-toggle" data-enabled="true"<?php echo $lock_dividends ? ' disabled' : ''; ?>>
                            <?php esc_html_e('Включено', 'momentum-screener'); ?>
                        </button>
                    </div>
                </div>

                <div class="ms-option<?php echo $lock_skip ? ' ms-option-locked' : ''; ?>">
                    <div class="ms-option-header">
                        <div>
                            <h4><?php esc_html_e('Reversal Effect: пропустить N последних недель', 'momentum-screener'); ?></h4>
                            <p id="ms-skip-desc"><?php esc_html_e('Исключает последние N недель из расчета momentum. 0 = выключено, 4 ≈ 1 месяц.', 'momentum-screener'); ?></p>
                        </div>
                    </div>
                    <div class="ms-option-body" style="display: block;">
                        <label><?php esc_html_e('Пропустить:', 'momentum-screener'); ?> <span id="ms-skip-weeks-value">4 нед</span></label>
                        <input type="range" id="ms-skip-weeks" min="0" max="4" step="1" value="4"<?php echo $lock_skip ? ' disabled' : ''; ?>>
                    </div>
                </div>
            </div>

            <div class="ms-option-row">
                <div class="ms-option ms-option-advanced<?php echo $lock_vol ? ' ms-option-locked' : ''; ?>">
                    <div class="ms-option-header">
                        <h4><?php esc_html_e('Фильтр волатильности', 'momentum-screener'); ?></h4>
                        <button class="ms-toggle<?php echo $lock_vol ? ' ms-locked' : ''; ?>" id="ms-volfilter-toggle" data-enabled="false"<?php echo $lock_vol ? ' disabled' : ''; ?>>
                            <?php esc_html_e('ВЫКЛ', 'momentum-screener'); ?>
                        </button>
                    </div>
                    <div class="ms-option-body" id="ms-volfilter-body" style="display: none;">
                        <label><?php esc_html_e('Макс. волатильность:', 'momentum-screener'); ?> <span id="ms-maxvol-value">50</span>%</label>
                        <input type="range" id="ms-maxvol" min="20" max="100" step="1" value="50"<?php echo $lock_vol ? ' disabled' : ''; ?>>
                        <p><?php esc_html_e('Исключает акции с волатильностью выше порога', 'momentum-screener'); ?></p>
                    </div>
                    <div class="ms-option-sub<?php echo $lock_riskadj ? ' ms-option-locked' : ''; ?>">
                        <span><?php esc_html_e('Риск-корректированный momentum', 'momentum-screener'); ?></span>
                        <button class="ms-toggle-small<?php echo $lock_riskadj ? ' ms-locked' : ''; ?>" id="ms-riskadj-toggle" data-enabled="false"<?php echo $lock_riskadj ? ' disabled' : ''; ?>>
                            <?php esc_html_e('ВЫКЛ', 'momentum-screener'); ?>
                        </button>
                    </div>
                </div>

                <div class="ms-option ms-option-advanced<?php echo $lock_return ? ' ms-option-locked' : ''; ?>">
                    <div class="ms-option-header">
                        <h4><?php esc_html_e('Фильтр границ доходности', 'momentum-screener'); ?></h4>
                        <button class="ms-toggle<?php echo $lock_return ? ' ms-locked' : ''; ?>" id="ms-returnfilter-toggle" data-enabled="false"<?php echo $lock_return ? ' disabled' : ''; ?>>
                            <?php esc_html_e('ВЫКЛ', 'momentum-screener'); ?>
                        </button>
                    </div>
                    <div class="ms-option-body" id="ms-returnfilter-body" style="display: none;">
                        <label><?php esc_html_e('Мин. доходность:', 'momentum-screener'); ?> <span id="ms-minreturn-value">30</span>%</label>
                        <input type="range" id="ms-minreturn" min="-50" max="100" step="5" value="30"<?php echo $lock_return ? ' disabled' : ''; ?>>
                        <label style="margin-top:8px;"><?php esc_html_e('Макс. доходность:', 'momentum-screener'); ?> <span id="ms-maxreturn-value">160</span>%</label>
                        <input type="range" id="ms-maxreturn" min="50" max="300" step="10" value="160"<?php echo $lock_return ? ' disabled' : ''; ?>>
                        <p><?php esc_html_e('Исключает акции за пределами диапазона доходности. Оптимум: от +30% до 160%.', 'momentum-screener'); ?></p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Metrics -->
        <div class="ms-metrics" id="ms-metrics">
            <div class="ms-metric ms-metric-primary">
                <span class="ms-metric-label"><?php esc_html_e('Общая доходность', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-total-return">-</span>
            </div>
            <div class="ms-metric ms-metric-primary">
                <span class="ms-metric-label"><?php esc_html_e('Годовая доходность', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-annual-return">-</span>
            </div>
            <div class="ms-metric ms-metric-primary">
                <span class="ms-metric-label"><?php esc_html_e('Коэф. Шарпа', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-sharpe">-</span>
            </div>
            <div class="ms-metric ms-metric-primary">
                <span class="ms-metric-label"><?php esc_html_e('Коэф. Сортино', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-sortino">-</span>
            </div>
            <div class="ms-metric ms-metric-primary">
                <span class="ms-metric-label"><?php esc_html_e('Макс. просадка', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-drawdown">-</span>
            </div>
        </div>

        <div class="ms-metrics-secondary">
            <div class="ms-metric">
                <span class="ms-metric-label"><?php esc_html_e('Средняя доходность периода', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-avg-return">-</span>
            </div>
            <div class="ms-metric">
                <span class="ms-metric-label"><?php esc_html_e('Волатильность', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-volatility">-</span>
            </div>
            <div class="ms-metric">
                <span class="ms-metric-label"><?php esc_html_e('Количество сделок', 'momentum-screener'); ?></span>
                <span class="ms-metric-value" id="ms-trades">-</span>
            </div>
        </div>

        <!-- Charts -->
        <div class="ms-charts" id="ms-charts">
            <div class="ms-chart-container">
                <h3><?php esc_html_e('Кривая капитала', 'momentum-screener'); ?></h3>
                <canvas id="ms-equity-chart"></canvas>
            </div>
            <div class="ms-chart-container">
                <h3><?php esc_html_e('Распределение доходности периодов', 'momentum-screener'); ?></h3>
                <canvas id="ms-returns-chart"></canvas>
            </div>
        </div>

        <!-- Current Recommendations -->
        <div class="ms-recommendations" id="ms-recommendations">
            <div class="ms-recommendations-header">
                <div>
                    <h3><?php esc_html_e('Текущие рекомендации', 'momentum-screener'); ?></h3>
                    <p id="ms-recommendations-date"></p>
                </div>
                <div class="ms-recommendations-info">
                    <div>
                        <span class="ms-label"><?php esc_html_e('Размер портфеля', 'momentum-screener'); ?></span>
                        <span class="ms-value" id="ms-portfolio-size">-</span>
                    </div>
                </div>
            </div>
            <div class="ms-stocks-grid" id="ms-stocks-grid"></div>
            <div class="ms-recommendations-tip">
                <p><?php esc_html_e('Совет: Распределите капитал равными долями между всеми акциями.', 'momentum-screener'); ?></p>
            </div>
        </div>

        <!-- Trade History -->
        <div class="ms-history" id="ms-history">
            <h3><?php esc_html_e('История сделок', 'momentum-screener'); ?></h3>
            <p class="ms-history-desc"><?php esc_html_e('Кликните на период, чтобы увидеть детали по каждой акции', 'momentum-screener'); ?></p>
            <table class="ms-history-table">
                <thead>
                    <tr>
                        <th><?php esc_html_e('Дата покупки', 'momentum-screener'); ?></th>
                        <th><?php esc_html_e('Дата продажи', 'momentum-screener'); ?></th>
                        <th><?php esc_html_e('Акций', 'momentum-screener'); ?></th>
                        <th><?php esc_html_e('Доходность', 'momentum-screener'); ?></th>
                        <th><?php esc_html_e('Детали', 'momentum-screener'); ?></th>
                    </tr>
                </thead>
                <tbody id="ms-history-body"></tbody>
            </table>
        </div>

        <!-- Tips -->
        <div class="ms-tips" id="ms-tips">
            <h3><?php esc_html_e('Рекомендации', 'momentum-screener'); ?></h3>
            <div id="ms-tips-content"></div>
        </div>
    </div>
</div>
