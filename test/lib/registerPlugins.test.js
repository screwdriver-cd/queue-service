'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');

sinon.assert.expose(assert, { prefix: '' });

describe('Register Plugins', () => {
    const resourcePlugins = [
        '../plugins/worker',
        '../plugins/queue',
        '../plugins/status',
        '../plugins/auth',
        '../plugins/shutdown'
    ];
    const defaultPlugin = ['blipp', 'hapi-auth-jwt2'];
    const pluginLength = resourcePlugins.length + defaultPlugin.length;
    const mocks = {};
    const config = {};
    let main;
    let serverMock;

    before(() => {
        mockery.enable({
            warnOnUnregistered: false,
            useCleanCache: true
        });
    });

    beforeEach(() => {
        serverMock = {
            register: sinon.stub(),
            on: sinon.stub()
        };
        resourcePlugins.forEach(plugin => {
            mocks[plugin] = sinon.stub();
            mockery.registerMock(plugin, mocks[plugin]);
        });

        /* eslint-disable global-require */
        main = require('../../lib/registerPlugins');
        /* eslint-enable global-require */
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
        main = null;
    });

    after(() => {
        mockery.disable();
    });

    it('registered resource plugins', async () => {
        await main(serverMock, config);

        assert.equal(serverMock.register.callCount, pluginLength);

        resourcePlugins.forEach(plugin => {
            assert.calledWith(serverMock.register, {
                plugin: mocks[plugin],
                options: {
                    ...(config[plugin.split('/')[2]] || {})
                },
                routes: {
                    prefix: '/v1'
                }
            });
        });
    });

    it('bubbles failures up', async () => {
        serverMock.register = sinon.stub().throws(new Error('failure loading'));
        try {
            await main(serverMock, config);
        } catch (err) {
            assert.equal(err.message, 'failure loading');
        }
    });

    it('registers data for plugin when specified in the config object', async () => {
        await main(serverMock, {
            queue: {
                foo: 'bar'
            }
        });
        assert.equal(serverMock.register.callCount, pluginLength);

        assert.calledWith(serverMock.register, {
            plugin: mocks['../plugins/queue'],
            options: {
                foo: 'bar'
            },
            routes: {
                prefix: '/v1'
            }
        });
    });
});
