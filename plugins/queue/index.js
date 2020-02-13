'use strict';
const putRoute = require('./put');
const deleteRoute = require('./delete');

const queuePlugin = {
    name: 'queue',
    register: async function (server, options) {
        server.route([
            putRoute(),
            deleteRoute()
        ]);
    }
};

module.exports = queuePlugin;