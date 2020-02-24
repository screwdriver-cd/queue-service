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
        server.register({
            plugin: '../plugins/worker',
            options: {
                name: 'worker'
            },
            routes: {
                prefix: '/v1'
            }
        });
        mockWorker = {
            invoke: sinon.stub().returns('Success')
        };
        options = {
            method: 'POST',
            url: '/queue/worker',
            payload: {
            }
        };
        mockery.registerMock('./worker', mockWorker);
    });

    it('returns 200 when invoking worker', () =>
        server.inject(options).then((reply) => {
            assert.equal(reply.statusCode, 200);
        })
    );

    it('returns 500 when build update returns an error', () =>
        server.inject(options).then((reply) => {
            assert.equal(reply.statusCode, 500);
        }));
});
