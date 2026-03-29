/**
 * Momentum Screener - Admin JavaScript
 * Media Library file selector
 */

(function($) {
    'use strict';

    $(document).ready(function() {
        // Upload button click
        $('.ms-upload-btn').on('click', function(e) {
            e.preventDefault();

            var button = $(this);
            var targetId = button.data('target');
            var targetName = button.data('name');

            // Create media frame
            var frame = wp.media({
                title: 'Выберите Excel файл',
                button: {
                    text: 'Выбрать'
                },
                library: {
                    type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel']
                },
                multiple: false
            });

            // When file is selected
            frame.on('select', function() {
                var attachment = frame.state().get('selection').first().toJSON();

                $('#' + targetId).val(attachment.id);
                $('#' + targetName).val(attachment.filename);
                button.siblings('.ms-remove-btn').show();
            });

            frame.open();
        });

        // Remove button click
        $('.ms-remove-btn').on('click', function(e) {
            e.preventDefault();

            var button = $(this);
            var targetId = button.data('target');
            var targetName = button.data('name');

            $('#' + targetId).val('');
            $('#' + targetName).val('');
            button.hide();
        });
    });

})(jQuery);
