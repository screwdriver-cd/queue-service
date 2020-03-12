'use strict';

const putRoute = require('./put');
const deleteRoute = require('./delete');
const statsRoute = require('./stats');

const queuePlugin = {
    name: 'queue',
    async register(server) {
        server.route([putRoute(), deleteRoute(), statsRoute()]);
    }
};

module.exports = queuePlugin;
