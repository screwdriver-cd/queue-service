'use strict';

const createRoute = require('./create');
const worker = require('./worker');

const workerPlugin = {
    name: 'worker',
    async register(server) {
        /**
         * Exposes an init function to begin the worker process
         * @method init
         * @return {Promise}
         */
        server.expose('init', async () => {
            return worker.invoke();
        });

        /**
         * Exposes an cleanUp function to end multiworker and scheduler process
         * @method cleanUp
         * @return {Promise}
         */
        server.expose('cleanUp', async () => {
            return worker.cleanUp();
        });

        server.route([createRoute()]);
    }
};

module.exports = workerPlugin;
