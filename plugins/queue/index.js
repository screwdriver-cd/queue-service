'use strict';

const putRoute = require('./put');
const deleteRoute = require('./delete');
const statsRoute = require('./stats');
const scheduler = require('./scheduler');

const queuePlugin = {
    name: 'queue',
    async register(server, options) {
        /**
         * Exposes an init function to begin the scheduler process
         * @method init
         * @param {Object} executor object with queue context
         * @return {Promise}
         */
        server.expose('init', async executor => {
            return scheduler.init(executor);
        });

        /**
         * Exposes an cleanUp function to cleanup queue and the scheduler process
         * @method cleanUp
         * @param {Object} executor object with queue context
         * @return {Promise}
         */
        server.expose('cleanUp', async executor => {
            return scheduler.cleanUp(executor);
        });

        server.route([putRoute(options), deleteRoute(), statsRoute()]);
    }
};

module.exports = queuePlugin;
