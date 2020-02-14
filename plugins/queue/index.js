'use strict';
const putRoute = require('./put');
const deleteRoute = require('./delete');
const statsRoute = require('./stats');

const queuePlugin = {
    name: 'queue',
    register: async function (server, options) {
        server.route([
            putRoute(),
            deleteRoute(),
            statsRoute()
        ]);
    }
};

module.exports = queuePlugin;