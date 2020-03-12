'use strict';

const { assert } = require('chai');
const boom = require('@hapi/boom');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('server case', () => {
    let hapiEngine;
    const ecosystem = {
        queue: 'http://example.com'
    };
    const config = {
        ecosystem,
        queueConfig: {
            redisConnection: {
                port: 4321,
                host: '127.0.0.0',
                options: {
                    tls: true,
                    password: 'abcd'
                }
            }
        }
    };

    before(() => {
        mockery.enable({
            warnOnUnregistered: false,
            useCleanCache: true
        });
    });

    beforeEach(() => {
        const mockRedis = sinon.stub().returns({});

        mockery.registerMock('ioredis', mockRedis);
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
        hapiEngine = null;
    });

    after(() => {
        mockery.disable();
    });

    describe('starts the server', async () => {
        let registrationManMock;
        let executorQueueMock;
        let error;
        let server;

        beforeEach(async () => {
            registrationManMock = sinon.stub();
            executorQueueMock = sinon.stub();
            mockery.registerMock('./registerPlugins', registrationManMock);
            mockery.registerMock('../lib/queue', executorQueueMock);

            /* eslint-disable global-require */
            hapiEngine = require('../../lib/server');
            /* eslint-enable global-require */

            registrationManMock.resolves(null);

            const svcConfig = { ...config, httpd: { port: 12347 } };

            server = await hapiEngine(svcConfig);
        });

        afterEach(() => {
            server.stop();
        });

        it('starts with a different port', async () => {
            assert.notOk(error);

            const response = await server.inject({
                method: 'GET',
                url: '/blah'
            });

            assert.equal(response.statusCode, 404);
            assert.include(response.request.info.host, '12347');
        });

        it('populates server.app values', () => {
            assert.isObject(server.app);
            assert.isObject(server.app.executorQueue);
        });
    });

    describe('fails to start server', () => {
        let registrationManMock;

        beforeEach(() => {
            registrationManMock = sinon.stub();
            mockery.registerMock('./registerPlugins', registrationManMock);

            /* eslint-disable global-require */
            hapiEngine = require('../../lib/server');
            /* eslint-enable global-require */
        });

        it('calls errors with register plugins', () => {
            registrationManMock.rejects(new Error('registrationMan fail'));
            const svcConfig = { ...config, httpd: { port: 12347 } };

            return hapiEngine(svcConfig).catch(error => {
                assert.strictEqual('registrationMan fail', error.message);
            });
        });
    });

    describe('error handling', () => {
        let srvConfig;
        let hapiServer;

        beforeEach(async () => {
            mockery.registerMock('./registerPlugins', server => {
                server.route({
                    method: 'GET',
                    path: '/yes',
                    handler: (_request, h) => h.response('OK')
                });
                server.route({
                    method: 'GET',
                    path: '/no',
                    handler: () => {
                        throw new Error('Not OK');
                    }
                });
                server.route({
                    method: 'GET',
                    path: '/noStack',
                    handler: () => {
                        throw new Error('whatStackTrace');
                    }
                });

                server.route({
                    method: 'GET',
                    path: '/noWithResponse',
                    handler: () => {
                        throw boom.conflict('conflict', { conflictOn: 1 });
                    }
                });

                return Promise.resolve();
            });

            srvConfig = { ...config, httpd: { port: 12348 } };

            /* eslint-disable global-require */
            hapiEngine = require('../../lib/server');
            /* eslint-enable global-require */

            hapiServer = await hapiEngine(srvConfig);
        });

        afterEach(() => {
            hapiServer.stop();
        });

        it('doesnt affect non-errors', async () => {
            const response = await hapiServer.inject({
                method: 'GET',
                url: '/yes'
            });

            assert.equal(response.statusCode, 200);
        });

        it('doesnt affect errors', async () => {
            const response = await hapiServer.inject({
                method: 'GET',
                url: '/no'
            });

            assert.equal(response.statusCode, 500);
            assert.equal(JSON.parse(response.payload).message, 'Not OK');
        });

        it('defaults to the error message if the stack trace is missing', () =>
            hapiServer
                .inject({
                    method: 'GET',
                    url: '/noStack'
                })
                .then(response => {
                    assert.equal(response.statusCode, 500);
                    assert.equal(JSON.parse(response.payload).message, 'whatStackTrace');
                }));

        it('responds with error response data', () =>
            hapiServer
                .inject({
                    method: 'GET',
                    url: '/noWithResponse'
                })
                .then(response => {
                    const { message, data } = JSON.parse(response.payload);

                    assert.equal(response.statusCode, 409);
                    assert.equal(message, 'conflict');
                    assert.deepEqual(data, { conflictOn: 1 });
                }));
    });
});

process.on('unhandledRejection', e => {
    console.log('=========>>12312', e);
    throw e;
});
