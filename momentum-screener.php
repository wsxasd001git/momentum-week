<?php
/**
 * Plugin Name: Momentum Week для российских акций
 * Plugin URI: https://github.com/momentum-screener
 * Description: Недельный скринер моментума для российского рынка акций с бэктестингом и рекомендациями
 * Version: 1.2.0
 * Author: Momentum Screener Team
 * Author URI: https://github.com/momentum-screener
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: momentum-week
 * Domain Path: /languages
 */

// Prevent direct access
if (!defined('ABSPATH')) {
    exit;
}

// Define plugin constants
define('MOMENTUM_WEEK_VERSION', '1.2.0');
define('MOMENTUM_WEEK_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('MOMENTUM_WEEK_PLUGIN_URL', plugin_dir_url(__FILE__));

/**
 * Main Plugin Class
 */
class Momentum_Week {

    private static $instance = null;

    /**
     * Get singleton instance
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    /**
     * Constructor
     */
    private function __construct() {
        $this->init_hooks();
    }

    /**
     * Initialize hooks
     */
    private function init_hooks() {
        // Allow XLSX uploads
        add_filter('upload_mimes', array($this, 'allow_xlsx_upload'));
        add_filter('wp_check_filetype_and_ext', array($this, 'fix_xlsx_upload'), 10, 5);

        // Admin hooks
        add_action('admin_menu', array($this, 'add_admin_menu'));
        add_action('admin_init', array($this, 'register_settings'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_admin_scripts'));

        // Frontend hooks
        add_action('wp_enqueue_scripts', array($this, 'enqueue_frontend_scripts'));
        add_shortcode('momentum_week', array($this, 'render_shortcode'));

        // AJAX hooks
        add_action('wp_ajax_momentum_week_get_file_url', array($this, 'ajax_get_file_url'));
        add_action('wp_ajax_nopriv_momentum_week_get_file_url', array($this, 'ajax_get_file_url'));
    }

    /**
     * Allow XLSX file uploads
     */
    public function allow_xlsx_upload($mimes) {
        $mimes['xlsx'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        $mimes['xls'] = 'application/vnd.ms-excel';
        return $mimes;
    }

    /**
     * Fix XLSX upload check
     */
    public function fix_xlsx_upload($data, $file, $filename, $mimes, $real_mime = '') {
        if (!empty($data['ext']) && !empty($data['type'])) {
            return $data;
        }

        $filetype = wp_check_filetype($filename, $mimes);

        if ('xlsx' === $filetype['ext']) {
            $data['ext'] = 'xlsx';
            $data['type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        } elseif ('xls' === $filetype['ext']) {
            $data['ext'] = 'xls';
            $data['type'] = 'application/vnd.ms-excel';
        }

        return $data;
    }

    /**
     * Add admin menu
     */
    public function add_admin_menu() {
        add_options_page(
            __('Momentum Week', 'momentum-week'),
            __('Momentum Week', 'momentum-week'),
            'manage_options',
            'momentum-week',
            array($this, 'render_admin_page')
        );
    }

    /**
     * Register settings
     */
    public function register_settings() {
        register_setting('momentum_week_options', 'momentum_week_settings', array(
            'sanitize_callback' => array($this, 'sanitize_settings')
        ));

        add_settings_section(
            'momentum_week_main',
            __('Настройки источника данных', 'momentum-week'),
            array($this, 'settings_section_callback'),
            'momentum-week'
        );

        add_settings_field(
            'excel_file_id',
            __('Excel файл с данными', 'momentum-week'),
            array($this, 'excel_file_callback'),
            'momentum-week',
            'momentum_week_main'
        );

        add_settings_field(
            'default_lookback',
            __('Период расчета по умолчанию (нед)', 'momentum-week'),
            array($this, 'default_lookback_callback'),
            'momentum-week',
            'momentum_week_main'
        );

        add_settings_field(
            'default_holding',
            __('Период удержания по умолчанию (нед)', 'momentum-week'),
            array($this, 'default_holding_callback'),
            'momentum-week',
            'momentum_week_main'
        );

        add_settings_field(
            'default_topn',
            __('Количество акций по умолчанию', 'momentum-week'),
            array($this, 'default_topn_callback'),
            'momentum-week',
            'momentum_week_main'
        );
    }

    /**
     * Sanitize settings
     */
    public function sanitize_settings($input) {
        $sanitized = array();

        if (isset($input['excel_file_id'])) {
            $sanitized['excel_file_id'] = absint($input['excel_file_id']);
        }

        if (isset($input['default_lookback'])) {
            $sanitized['default_lookback'] = min(52, max(1, absint($input['default_lookback'])));
        }

        if (isset($input['default_holding'])) {
            $sanitized['default_holding'] = min(10, max(1, absint($input['default_holding'])));
        }

        if (isset($input['default_topn'])) {
            $sanitized['default_topn'] = min(30, max(5, absint($input['default_topn'])));
        }

        return $sanitized;
    }

    /**
     * Settings section callback
     */
    public function settings_section_callback() {
        echo '<p>' . esc_html__('Загрузите Excel файл с ценами акций через медиа-библиотеку WordPress.', 'momentum-week') . '</p>';
    }

    /**
     * Excel file field callback
     */
    public function excel_file_callback() {
        $options = get_option('momentum_week_settings');
        $file_id = isset($options['excel_file_id']) ? $options['excel_file_id'] : '';
        $file_url = $file_id ? wp_get_attachment_url($file_id) : '';
        $file_name = $file_id ? basename(get_attached_file($file_id)) : '';

        ?>
        <div class="ms-file-upload">
            <input type="hidden" name="momentum_week_settings[excel_file_id]" id="excel_file_id" value="<?php echo esc_attr($file_id); ?>" />
            <input type="text" id="excel_file_name" value="<?php echo esc_attr($file_name); ?>" class="regular-text" readonly />
            <button type="button" class="button ms-upload-btn" data-target="excel_file_id" data-name="excel_file_name">
                <?php esc_html_e('Выбрать файл', 'momentum-week'); ?>
            </button>
            <button type="button" class="button ms-remove-btn" data-target="excel_file_id" data-name="excel_file_name" <?php echo empty($file_id) ? 'style="display:none;"' : ''; ?>>
                <?php esc_html_e('Удалить', 'momentum-week'); ?>
            </button>
        </div>
        <p class="description"><?php esc_html_e('Файл должен содержать лист "цены". Опционально: лист "дивиденды" или "Дивид"', 'momentum-week'); ?></p>
        <?php
    }

    /**
     * Default lookback field callback
     */
    public function default_lookback_callback() {
        $options = get_option('momentum_week_settings');
        $value = isset($options['default_lookback']) ? $options['default_lookback'] : 13;
        echo '<input type="number" name="momentum_week_settings[default_lookback]" value="' . esc_attr($value) . '" min="1" max="52" class="small-text" />';
    }

    /**
     * Default holding field callback
     */
    public function default_holding_callback() {
        $options = get_option('momentum_week_settings');
        $value = isset($options['default_holding']) ? $options['default_holding'] : 4;
        echo '<input type="number" name="momentum_week_settings[default_holding]" value="' . esc_attr($value) . '" min="1" max="10" class="small-text" />';
    }

    /**
     * Default topN field callback
     */
    public function default_topn_callback() {
        $options = get_option('momentum_week_settings');
        $value = isset($options['default_topn']) ? $options['default_topn'] : 10;
        echo '<input type="number" name="momentum_week_settings[default_topn]" value="' . esc_attr($value) . '" min="5" max="30" class="small-text" />';
    }

    /**
     * Render admin page
     */
    public function render_admin_page() {
        if (!current_user_can('manage_options')) {
            return;
        }
        ?>
        <div class="wrap">
            <h1><?php echo esc_html(get_admin_page_title()); ?></h1>

            <form action="options.php" method="post">
                <?php
                settings_fields('momentum_week_options');
                do_settings_sections('momentum-week');
                submit_button(__('Сохранить настройки', 'momentum-week'));
                ?>
            </form>

            <hr>

            <h2><?php esc_html_e('Использование', 'momentum-week'); ?></h2>
            <p><?php esc_html_e('Используйте шорткод на любой странице:', 'momentum-week'); ?></p>
            <code>[momentum_week]</code>

            <h3><?php esc_html_e('Параметры шорткода:', 'momentum-week'); ?></h3>
            <ul>
                <li><code>lookback="13"</code> - <?php esc_html_e('Период расчета momentum (1-52 нед)', 'momentum-week'); ?></li>
                <li><code>holding="4"</code> - <?php esc_html_e('Период удержания (1-10 нед)', 'momentum-week'); ?></li>
                <li><code>topn="10"</code> - <?php esc_html_e('Количество акций в портфеле (5-30)', 'momentum-week'); ?></li>
            </ul>

            <h3><?php esc_html_e('Блокировка фильтров:', 'momentum-week'); ?></h3>
            <p><?php esc_html_e('Добавьте атрибуты lock_*="1", чтобы запретить пользователю изменять соответствующий параметр. Пример:', 'momentum-week'); ?></p>
            <code>[momentum_week lookback="26" holding="4" topn="15" lock_lookback="1" lock_holding="1"]</code>
            <table class="widefat striped" style="margin-top:12px; max-width:700px;">
                <thead>
                    <tr>
                        <th><?php esc_html_e('Атрибут', 'momentum-week'); ?></th>
                        <th><?php esc_html_e('Что блокирует', 'momentum-week'); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td><code>lock_lookback="1"</code></td><td><?php esc_html_e('Период расчёта momentum', 'momentum-week'); ?></td></tr>
                    <tr><td><code>lock_holding="1"</code></td><td><?php esc_html_e('Период удержания', 'momentum-week'); ?></td></tr>
                    <tr><td><code>lock_topn="1"</code></td><td><?php esc_html_e('Количество акций в портфеле', 'momentum-week'); ?></td></tr>
                    <tr><td><code>lock_dividends="1"</code></td><td><?php esc_html_e('Тогл учёта дивидендов', 'momentum-week'); ?></td></tr>
                    <tr><td><code>lock_skip="1"</code></td><td><?php esc_html_e('Слайдер Reversal Effect (пропуск N последних недель)', 'momentum-week'); ?></td></tr>
                    <tr><td><code>lock_vol="1"</code></td><td><?php esc_html_e('Фильтр волатильности (тогл + слайдер)', 'momentum-week'); ?></td></tr>
                    <tr><td><code>lock_riskadj="1"</code></td><td><?php esc_html_e('Риск-корректированный momentum', 'momentum-week'); ?></td></tr>
                    <tr><td><code>lock_return="1"</code></td><td><?php esc_html_e('Фильтр границ доходности (тогл + слайдеры)', 'momentum-week'); ?></td></tr>
                </tbody>
            </table>

            <hr>

            <h2><?php esc_html_e('Требования к Excel файлу', 'momentum-week'); ?></h2>
            <ul>
                <li><?php esc_html_e('Формат: .xlsx', 'momentum-week'); ?></li>
                <li><?php esc_html_e('Лист с названием "цены"', 'momentum-week'); ?></li>
                <li><?php esc_html_e('Первый столбец: Time (даты)', 'momentum-week'); ?></li>
                <li><?php esc_html_e('Остальные столбцы: тикеры акций с ценами', 'momentum-week'); ?></li>
                <li><?php esc_html_e('Опционально: лист "дивиденды" или "Дивид" с дивидендами', 'momentum-week'); ?></li>
            </ul>
        </div>
        <?php
    }

    /**
     * Enqueue admin scripts
     */
    public function enqueue_admin_scripts($hook) {
        if ('settings_page_momentum-week' !== $hook) {
            return;
        }

        wp_enqueue_media();

        wp_enqueue_style(
            'momentum-week-admin',
            MOMENTUM_WEEK_PLUGIN_URL . 'assets/css/admin.css',
            array(),
            MOMENTUM_WEEK_VERSION
        );

        wp_enqueue_script(
            'momentum-week-admin',
            MOMENTUM_WEEK_PLUGIN_URL . 'assets/js/admin.js',
            array('jquery'),
            MOMENTUM_WEEK_VERSION,
            true
        );
    }

    /**
     * Enqueue frontend scripts
     */
    public function enqueue_frontend_scripts() {
        global $post;

        if (!is_a($post, 'WP_Post') || !has_shortcode($post->post_content, 'momentum_week')) {
            return;
        }

        // Enqueue Chart.js
        wp_enqueue_script(
            'chartjs',
            'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
            array(),
            '4.4.1',
            true
        );

        // Enqueue SheetJS for Excel parsing
        wp_enqueue_script(
            'sheetjs',
            'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
            array(),
            '0.18.5',
            true
        );

        // Enqueue plugin styles
        wp_enqueue_style(
            'momentum-week',
            MOMENTUM_WEEK_PLUGIN_URL . 'assets/css/momentum-screener.css',
            array(),
            MOMENTUM_WEEK_VERSION
        );

        // Enqueue plugin script
        wp_enqueue_script(
            'momentum-week',
            MOMENTUM_WEEK_PLUGIN_URL . 'assets/js/momentum-screener.js',
            array('jquery', 'chartjs', 'sheetjs'),
            MOMENTUM_WEEK_VERSION,
            true
        );

        // Get settings
        $options = get_option('momentum_week_settings');

        // Get file URL
        $excel_url = '';
        if (!empty($options['excel_file_id'])) {
            $excel_url = wp_get_attachment_url($options['excel_file_id']);
        }

        // Localize script
        wp_localize_script('momentum-week', 'momentumScreener', array(
            'excelUrl'  => $excel_url,
            'workerUrl' => MOMENTUM_WEEK_PLUGIN_URL . 'assets/js/momentum-worker.js',
            'defaults' => array(
                'lookback' => isset($options['default_lookback']) ? intval($options['default_lookback']) : 13,
                'holding' => isset($options['default_holding']) ? intval($options['default_holding']) : 4,
                'topn' => isset($options['default_topn']) ? intval($options['default_topn']) : 10,
            ),
            'strings' => array(
                'loading' => __('Загрузка данных...', 'momentum-week'),
                'error' => __('Ошибка загрузки данных', 'momentum-week'),
                'noData' => __('Данные не найдены', 'momentum-week'),
                'noFile' => __('Excel файл не настроен. Перейдите в Настройки > Momentum Week', 'momentum-week'),
            )
        ));
    }

    /**
     * Render shortcode
     */
    public function render_shortcode($atts) {
        $options = get_option('momentum_week_settings');

        $atts = shortcode_atts(array(
            'lookback' => isset($options['default_lookback']) ? $options['default_lookback'] : 13,
            'holding' => isset($options['default_holding']) ? $options['default_holding'] : 4,
            'topn' => isset($options['default_topn']) ? $options['default_topn'] : 10,
            'lock_lookback' => '0',
            'lock_holding' => '0',
            'lock_topn' => '0',
            'lock_dividends' => '0',
            'lock_skip' => '0',
            'lock_vol' => '0',
            'lock_riskadj' => '0',
            'lock_return' => '0',
        ), $atts);

        ob_start();
        include MOMENTUM_WEEK_PLUGIN_DIR . 'includes/shortcode-template.php';
        return ob_get_clean();
    }

    /**
     * AJAX handler for getting file URL
     */
    public function ajax_get_file_url() {
        $options = get_option('momentum_week_settings');

        $excel_url = '';
        if (!empty($options['excel_file_id'])) {
            $excel_url = wp_get_attachment_url($options['excel_file_id']);
        }

        wp_send_json_success(array(
            'excelUrl' => $excel_url
        ));
    }
}

// Initialize plugin
function momentum_week_init() {
    return Momentum_Week::get_instance();
}
add_action('plugins_loaded', 'momentum_week_init');

// Activation hook
register_activation_hook(__FILE__, 'momentum_week_activate');
function momentum_week_activate() {
    // Set default options
    $defaults = array(
        'excel_file_id' => '',
        'default_lookback' => 13,
        'default_holding' => 4,
        'default_topn' => 10,
    );

    add_option('momentum_week_settings', $defaults);
}

// Deactivation hook
register_deactivation_hook(__FILE__, 'momentum_week_deactivate');
function momentum_week_deactivate() {
    // Nothing to clean up
}
