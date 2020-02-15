'use strict';

const createRoute = require('./create');

const workerPlugin = {
    name: 'worker',
    async register(server) {
        server.route([
            createRoute()
        ]);
    }
};

module.exports = workerPlugin;
