'use strict';

const assert = require('chai').assert;
const sinon = require('sinon');
const mockery = require('mockery');
const hapi = require('@hapi/hapi');

sinon.assert.expose(assert, { prefix: '' });

describe('POST /queue/worker', () => {
    let options;
    let mockWorker;
    let server;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    afterEach(() => {
        server = null;
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    beforeEach(() => {
        server = new hapi.Server({
            port: 12345,
            host: 'localhost'
        });

        mockWorker = {
            invoke: sinon.stub().resolves('Success')
        };
        options = {
            method: 'POST',
            url: '/v1/queue/worker',
            payload: {}
        };
        mockery.registerMock('./worker', mockWorker);

        /* eslint-disable global-require */
        const plugin = require('../../../plugins/worker/index.js');
        /* eslint-enable global-require */

        server.register({
            plugin,
            options: {
                name: 'worker'
            },
            routes: {
                prefix: '/v1'
            }
        });
    });

    it('returns 200 when invoking worker', async () => {
        mockWorker.invoke = sinon.stub().resolves('Success');
        const reply = await server.inject(options);

        assert.equal(reply.statusCode, 200);
    });

    it('returns 500 when build update returns an error', async () => {
        mockWorker.invoke = sinon.stub().rejects(new Error('Failed'));
        const reply = await server.inject(options);

        assert.equal(reply.statusCode, 500);
    });
});
