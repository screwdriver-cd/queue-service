'use strict';

const chai = require('chai');
const { assert } = chai;
const hapi = require('@hapi/hapi');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('queue plugin test', () => {
    let plugin;
    let server;
    let authMock;
    let generateTokenMock;
    let generateProfileMock;
    let options;
    const jwtPrivateKey = 'test key';
    const jwtPublicKey = 'test public key';
    const jwtSDApiPublicKey = 'test api pubclic key';

    beforeEach(async () => {
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
                return h.authenticated();
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
        server.app = {
            executorQueue: {
                stats: sinon.stub().returns()
            }
        };
    });

    after(() => {
        server = null;
    });

    describe('constructor', () => {
        it('registers the queue plugin', () => {
            assert.isOk(server.registrations.queue);
        });
    });

    describe('GET /queue/stats', () => {
        beforeEach(() => {
            options = {
                method: 'GET',
                url: '/v1/queue/stats'
            };
        });

        it('returns 200 when fetching stats', async () => {
            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
        });

        it('Does not return 403 when scope is different', async () => {
            options = {
                method: 'GET',
                url: '/v1/queue/stats',
                auth: {
                    strategy: 'token',
                    credentials: {
                        scope: ['somescope']
                    }
                }
            };
            const reply = await server.inject(options);

            assert.equal(reply.statusCode, 200);
        });
    });
});
