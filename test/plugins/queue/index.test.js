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
    let authMock;
    let generateTokenMock;
    let generateProfileMock;
    let options;
    const jwtPrivateKey = 'test key';
    const jwtPublicKey = 'test public key';
    const jwtSDApiPublicKey = 'test api pubclic key';

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(async () => {
        schedulerMock = {
            start: sinon.stub().resolves(),
            startTimer: sinon.stub().resolves(),
            startFrozen: sinon.stub().resolves(),
            startPeriodic: sinon.stub().resolves(),
            stop: sinon.stub().resolves(),
            stopTimer: sinon.stub().resolves(),
            stopFrozen: sinon.stub().resolves(),
            stopPeriodic: sinon.stub().resolves(),
            clearCache: sinon.stub().resolves()
        };

        mockery.registerMock('./scheduler', schedulerMock);

        generateProfileMock = sinon.stub();
        generateTokenMock = sinon.stub();

        /* eslint-disable global-require */
        plugin = require('../../../plugins/queue/index');
        /* eslint-enable global-require */
        server = new hapi.Server({
            port: 1234
        });
        server.auth.scheme('custom', () => ({
            authenticate: (_, h) => {
                return h.authenticated({
                    credentials: {
                        scope: ['sdapi']
                    }
                });
            }
        }));
        server.auth.strategy('token', 'custom');

        authMock = {
            name: 'auth',
            async register(s) {
                s.expose('generateToken', generateTokenMock);
                s.expose('generateProfile', generateProfileMock);
            }
        };

        server.register({
            plugin: authMock,
            options: {
                jwtPrivateKey,
                jwtPublicKey,
                jwtSDApiPublicKey
            },
            routes: {
                prefix: '/v1'
            }
        });

        await server.register({
            plugin,
            options: {
                name: 'queue'
            },
            routes: {
                prefix: '/v1'
            }
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

    describe('DELETE /queue/message', () => {
        beforeEach(() => {
            options = {
                method: 'DELETE',
                payload: {},
                url: '/v1/queue/message',
                auth: {
                    strategy: 'token',
                    credentials: {
                        scope: ['sdapi']
                    }
                }
            };
        });

        it('returns 200 when deleting message from queue', async () => {
            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
        });

        it('returns 500 when build update returns an error', async () => {
            schedulerMock.stop.rejects('some error');
            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 500);
        });

        it('returns 403 Insufficient scope when scope is not sdapi', async () => {
            options.auth = {
                strategy: 'token',
                credentials: {
                    scope: ['user']
                }
            };

            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 403);
        });

        it('returns 200 when deleting message from queue', async () => {
            options.url = '/v1/queue/message?type=periodic';

            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
            assert.calledOnce(schedulerMock.stopPeriodic);
        });

        it('returns 200 when deleting message from queue', async () => {
            options.url = '/v1/queue/message?type=timer';

            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
            assert.calledOnce(schedulerMock.stopTimer);
        });
    });

    describe('POST /queue/message', () => {
        beforeEach(() => {
            options = {
                method: 'POST',
                payload: {},
                url: '/v1/queue/message',
                auth: {
                    strategy: 'token',
                    credentials: {
                        scope: ['sdapi']
                    }
                }
            };
        });

        it('returns 200 when pushing message to queue', async () => {
            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
        });

        it('returns 500 when build update returns an error', async () => {
            schedulerMock.start.rejects('some error');
            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 500);
        });

        it('returns 403 Insufficient scope when scope is not sdapi', async () => {
            options.auth = {
                strategy: 'token',
                credentials: {
                    scope: ['user']
                }
            };

            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 403);
        });

        it('returns 200 when deleting message from queue', async () => {
            options.url = '/v1/queue/message?type=periodic';

            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
            assert.calledOnce(schedulerMock.startPeriodic);
        });

        it('returns 200 when deleting message from queue', async () => {
            options.url = '/v1/queue/message?type=cache';

            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
            assert.calledOnce(schedulerMock.clearCache);
        });

        it('returns 200 when deleting message from queue', async () => {
            options.url = '/v1/queue/message?type=timer';

            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
            assert.calledOnce(schedulerMock.startTimer);
        });
    });
});
