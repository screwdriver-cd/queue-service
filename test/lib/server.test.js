'use strict';

const assert = require('chai').assert;
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
        let error;
        let server;

        before(() => {
            registrationManMock = sinon.stub();

            mockery.registerMock('./registerPlugins', registrationManMock);
            /* eslint-disable global-require */
            hapiEngine = require('../../lib/server');
            /* eslint-enable global-require */

            registrationManMock.resolves(null);

            return hapiEngine(Object.assign(config, {
                httpd: { port: 12347 }
            }))
                .then((s) => {
                    server = s;
                }).catch((e) => {
                    error = e;
                });
        });

        it('starts with a different port', () => {
            assert.notOk(error);

            return server.inject({
                method: 'GET',
                url: '/blah'
            }).then((response) => {
                assert.equal(response.statusCode, 404);
                assert.include(response.request.info.host, '12347');
            });
        });

        it('populates server.app values', () => {
            assert.isObject(server.app);
            assert.isObject(server.app.executorQueue);
        });

        it('injects server with route /v1/queue/message', () => {
            server.inject = sinon.stub();
            assert.calledWith(server.inject, {
                url: '/v1/queue/message',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                payload: {}
            });
        });

        it('injects server with route /v1/queue/worker', () => {
            server.inject = sinon.stub();
            assert.calledWith(server.inject, {
                url: '/v1/queue/worker',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                payload: {}
            });
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

            return hapiEngine(config).catch((error) => {
                assert.strictEqual('registrationMan fail', error.message);
            });
        });
    });

    describe('error handling', () => {
        beforeEach(() => {
            mockery.registerMock('./registerPlugins', (server) => {
                server.route({
                    method: 'GET',
                    path: '/yes',
                    handler: (request, reply) => reply('OK')
                });
                server.route({
                    method: 'GET',
                    path: '/no',
                    handler: (request, reply) => reply(new Error('Not OK'))
                });
                server.route({
                    method: 'GET',
                    path: '/noStack',
                    handler: (request, reply) => {
                        const response = boom.boomify(new Error('whatStackTrace'));

                        delete response.stack;

                        return reply(response);
                    }
                });

                server.route({
                    method: 'GET',
                    path: '/noWithResponse',
                    handler: (request, reply) => {
                        const response = boom.boomify(boom.conflict('conflict', { conflictOn: 1 }));

                        return reply(response);
                    }
                });

                return Promise.resolve();
            });
            /* eslint-disable global-require */
            hapiEngine = require('../../lib/server');
            /* eslint-enable global-require */
        });

        it('doesnt affect non-errors', () => (
            hapiEngine(config).then(server => (
                server.inject({
                    method: 'GET',
                    url: '/yes'
                }).then((response) => {
                    assert.equal(response.statusCode, 200);
                })
            ))
        ));

        it('doesnt affect errors', () => (
            hapiEngine(config).then(server => (
                server.inject({
                    method: 'GET',
                    url: '/no'
                }).then((response) => {
                    assert.equal(response.statusCode, 500);
                    assert.equal(JSON.parse(response.payload).message, 'Not OK');
                })
            ))
        ));

        it('defaults to the error message if the stack trace is missing', () => (
            hapiEngine(config).then(server => (
                server.inject({
                    method: 'GET',
                    url: '/noStack'
                }).then((response) => {
                    assert.equal(response.statusCode, 500);
                    assert.equal(JSON.parse(response.payload).message, 'whatStackTrace');
                })
            ))
        ));

        it('responds with error response data', () => (
            hapiEngine(config).then(server => (
                server.inject({
                    method: 'GET',
                    url: '/noWithResponse'
                }).then((response) => {
                    const { message, data } = JSON.parse(response.payload);

                    assert.equal(response.statusCode, 409);
                    assert.equal(message, 'conflict');
                    assert.deepEqual(data, { conflictOn: 1 });
                })
            ))
        ));
    });
});
