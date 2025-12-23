'use strict';

const { assert } = require('chai');
const sinon = require('sinon');
const mockery = require('mockery');

describe('LuaScriptLoader', () => {
    let LuaScriptLoader;
    let mockRedis;
    let loader;
    let mockFs;
    let mockPath;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        // Mock fs
        mockFs = {
            existsSync: sinon.stub(),
            readFileSync: sinon.stub(),
            readdirSync: sinon.stub()
        };

        // Mock path
        mockPath = {
            join: (...args) => args.join('/')
        };

        // Mock Redis
        mockRedis = {
            script: sinon.stub(),
            evalsha: sinon.stub()
        };

        mockery.registerMock('fs', mockFs);
        mockery.registerMock('path', mockPath);

        // eslint-disable-next-line global-require
        LuaScriptLoader = require('../../../../plugins/worker/lib/LuaScriptLoader');
        loader = new LuaScriptLoader(mockRedis);
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('loadScript', () => {
        it('loads a Lua script and caches its SHA', async () => {
            const scriptContent = 'return "hello"';
            const scriptSha = 'abc123def456';

            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns(scriptContent);
            mockRedis.script.withArgs('LOAD', scriptContent).resolves(scriptSha);

            const sha = await loader.loadScript('test.lua');

            assert.equal(sha, scriptSha);
            assert.isTrue(mockRedis.script.calledOnce);
            assert.isTrue(mockRedis.script.calledWith('LOAD', scriptContent));

            // Check cache
            assert.isTrue(loader.isScriptLoaded('test.lua'));
        });

        it('returns cached SHA if script already loaded', async () => {
            const scriptContent = 'return "hello"';
            const scriptSha = 'abc123def456';

            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns(scriptContent);
            mockRedis.script.resolves(scriptSha);

            // Load once
            await loader.loadScript('test.lua');

            // Reset spy
            mockRedis.script.resetHistory();

            // Load again
            const sha = await loader.loadScript('test.lua');

            assert.equal(sha, scriptSha);
            assert.isTrue(mockRedis.script.notCalled); // Should not call Redis again
        });

        it('throws error if script file not found', async () => {
            mockFs.existsSync.returns(false);

            try {
                await loader.loadScript('nonexistent.lua');
                assert.fail('Should have thrown error');
            } catch (err) {
                assert.include(err.message, 'Lua script not found');
            }
        });
    });

    describe('executeScript', () => {
        it('executes a script using EVALSHA', async () => {
            const scriptContent = 'return ARGV[1]';
            const scriptSha = 'abc123';
            const expectedResult = 'result';

            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns(scriptContent);
            mockRedis.script.resolves(scriptSha);
            mockRedis.evalsha.withArgs(scriptSha, 0, 'arg1').resolves(expectedResult);

            const result = await loader.executeScript('test.lua', [], ['arg1']);

            assert.equal(result, expectedResult);
            assert.isTrue(mockRedis.evalsha.calledOnce);
            assert.isTrue(mockRedis.evalsha.calledWith(scriptSha, 0, 'arg1'));
        });

        it('reloads script and retries on NOSCRIPT error', async () => {
            const scriptContent = 'return ARGV[1]';
            const scriptSha = 'abc123';
            const expectedResult = 'result';

            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns(scriptContent);
            mockRedis.script.resolves(scriptSha);

            // First call fails with NOSCRIPT
            mockRedis.evalsha.onFirstCall().rejects(new Error('NOSCRIPT: No matching script'));
            // Second call succeeds
            mockRedis.evalsha.onSecondCall().resolves(expectedResult);

            const result = await loader.executeScript('test.lua', [], ['arg1']);

            assert.equal(result, expectedResult);
            assert.isTrue(mockRedis.evalsha.calledTwice); // Called twice (fail + retry)
            assert.isTrue(mockRedis.script.calledTwice); // Script reloaded
        });

        it('throws error for non-NOSCRIPT errors', async () => {
            const scriptContent = 'return ARGV[1]';
            const scriptSha = 'abc123';

            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns(scriptContent);
            mockRedis.script.resolves(scriptSha);
            mockRedis.evalsha.rejects(new Error('Some other error'));

            try {
                await loader.executeScript('test.lua', [], ['arg1']);
                assert.fail('Should have thrown error');
            } catch (err) {
                assert.include(err.message, 'Some other error');
            }
        });
    });

    describe('loadAllScripts', () => {
        it('loads all .lua files in directory', async () => {
            mockFs.readdirSync.returns(['script1.lua', 'script2.lua', 'not-lua.txt', '.hidden.lua']);
            mockFs.existsSync.returns(true);
            mockFs.readFileSync.onFirstCall().returns('return 1');
            mockFs.readFileSync.onSecondCall().returns('return 2');
            mockRedis.script.resolves('sha123');

            const count = await loader.loadAllScripts();

            assert.equal(count, 2); // Only script1.lua and script2.lua
            assert.isTrue(mockRedis.script.calledTwice);
        });
    });

    describe('reloadScript', () => {
        it('clears cache and reloads script', async () => {
            const scriptContent = 'return "hello"';
            const scriptSha1 = 'sha1';
            const scriptSha2 = 'sha2';

            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns(scriptContent);

            // Load with first SHA
            mockRedis.script.onFirstCall().resolves(scriptSha1);
            await loader.loadScript('test.lua');

            const firstSha = await loader.getScriptSha('test.lua');

            assert.equal(firstSha, scriptSha1);

            // Reload with different SHA
            mockRedis.script.onSecondCall().resolves(scriptSha2);
            const newSha = await loader.reloadScript('test.lua');

            assert.equal(newSha, scriptSha2);
        });
    });

    describe('getLoadedScripts', () => {
        it('returns info about all loaded scripts', async () => {
            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns('return 1');
            mockRedis.script.resolves('sha123');

            await loader.loadScript('test.lua');

            const scripts = loader.getLoadedScripts();

            assert.equal(scripts.length, 1);
            assert.equal(scripts[0].name, 'test.lua');
            assert.equal(scripts[0].sha, 'sha123');
            assert.isNumber(scripts[0].size);
        });
    });

    describe('validateScript', () => {
        it('returns true if script exists in Redis', async () => {
            const scriptContent = 'return 1';
            const scriptSha = 'sha123';

            mockFs.existsSync.returns(true);
            mockFs.readFileSync.returns(scriptContent);
            mockRedis.script.withArgs('LOAD').resolves(scriptSha);
            mockRedis.script.withArgs('EXISTS', scriptSha).resolves([1]);

            await loader.loadScript('test.lua');
            const exists = await loader.validateScript('test.lua');

            assert.isTrue(exists);
        });

        it('returns false if script not in cache', async () => {
            const exists = await loader.validateScript('nonexistent.lua');

            assert.isFalse(exists);
        });
    });
});
