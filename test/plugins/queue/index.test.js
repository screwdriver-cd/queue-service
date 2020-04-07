'use strict';

const chai = require('chai');
const { assert } = chai;
const hapi = require('@hapi/hapi');
const sinon = require('sinon');
const mockery = require('mockery');

sinon.assert.expose(assert, { prefix: '' });

describe('queue plugin test', () => {
    let plugin;
    let server;
    let schedulerMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(async () => {
        schedulerMock = {
            init: sinon.stub().resolves()
        };

        mockery.registerMock('./schdeuler', schedulerMock);

        /* eslint-disable global-require */
        plugin = require('../../../plugins/queue');
        /* eslint-enable global-require */
        server = new hapi.Server({
            port: 1234
        });

        await server.register({
            plugin
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        server = null;
        mockery.disable();
    });

    describe('constructor', () => {
        it('registers the queue plugin', () => {
            assert.isOk(server.registrations.queue);
        });
    });
});
