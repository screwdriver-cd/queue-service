'use strict';
const createRoute = require('./create');

const workerPlugin = {
    name: 'worker',
    register: async function (server, options) {
        server.route([
            createRoute()
        ]);
    }
};

module.exports = workerPlugin;