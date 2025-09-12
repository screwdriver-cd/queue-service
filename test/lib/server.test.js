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
        queue: {
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
        const redisMock = {
            on: sinon.stub()
        };
        const redisConstructorMock = sinon.stub().returns(redisMock);

        mockery.registerMock('ioredis', redisConstructorMock);
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
            registrationManMock = async _server => {
                _server.plugins = {
                    queue: {
                        init: sinon.stub().resolves()
                    },
                    worker: {
                        init: sinon.stub().resolves()
                    }
                };
            };
            executorQueueMock = sinon.stub();
            mockery.registerMock('./registerPlugins', registrationManMock);
            mockery.registerMock('./queue', executorQueueMock);

            /* eslint-disable global-require */
            hapiEngine = require('../../lib/server');
            /* eslint-enable global-require */

            const svcConfig = { ...config, httpd: { port: 12347 } };

            try {
                server = await hapiEngine(svcConfig);
                server.plugins.auth = {
                    generateToken: sinon.stub().returns('foo'),
                    generateProfile: sinon.stub().returns('bar')
                };
            } catch (err) {
                error = err;
            }
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
            assert.isObject(server.app.executorQueue);
            assert.isFunction(server.app.executorQueue.tokenGen);
            assert.equal(server.app.executorQueue.tokenGen(), 'foo');
            assert.isFunction(server.app.executorQueue.userTokenGen);
            assert.equal(server.app.executorQueue.userTokenGen(), 'foo');
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

        it('logs err in case of unhandled rejection ', async () => {
            registrationManMock.rejects(new Error('registrationMan fail'));
            const svcConfig = { ...config, httpd: { port: 12347 } };

            try {
                await hapiEngine(svcConfig);
            } catch (err) {
                assert.isOk(err);
            }
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

                server.plugins = {
                    queue: {
                        init: sinon.stub().resolves()
                    },
                    worker: {
                        init: sinon.stub().resolves()
                    }
                };

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
