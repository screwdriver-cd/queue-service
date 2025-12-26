--[[
    stopBuild.lua - Atomic build stop/cleanup

    This script atomically cleans up all Redis state for a stopped build.

    ARGV[1]  = buildId (string)
    ARGV[2]  = jobId (string)
    ARGV[3]  = queuePrefix (string, e.g., "resque:")
    ARGV[4]  = runningJobsPrefix (string, e.g., "running_job_")
    ARGV[5]  = waitingJobsPrefix (string, e.g., "waiting_job_")

    Returns: JSON string with cleanup result
    {
        action: "CLEANED" | "NOT_RUNNING" | "PARTIAL",
        buildId: string,
        jobId: string,
        keysDeleted: {
            buildConfig: boolean,
            runningKey: boolean,
            lastRunningKey: boolean,
            waitingKey: boolean,
            timeoutConfig: boolean,
            deleteKey: boolean
        }
    }
]]


-- Parse arguments
local buildId = ARGV[1]
local jobId = ARGV[2]
local queuePrefix = ARGV[3]
local runningJobsPrefix = ARGV[4]
local waitingJobsPrefix = ARGV[5]

-- Convert buildId to number for comparison
local buildIdNum = tonumber(buildId)

-- Build Redis keys
local buildConfigKey = queuePrefix .. "buildConfigs"
local timeoutConfigKey = queuePrefix .. "timeoutConfigs"
local runningKey = runningJobsPrefix .. jobId
local lastRunningKey = "last_" .. runningJobsPrefix .. jobId
local waitingKey = waitingJobsPrefix .. jobId
local deleteKey = "deleted_" .. jobId .. "_" .. buildId

-- Read current state to validate ownership

local currentRunningBuildId = redis.call("GET", runningKey)
local lastRunningBuildId = redis.call("GET", lastRunningKey)
local buildConfigExists = redis.call("HEXISTS", buildConfigKey, buildId)

-- Track what gets deleted
local keysDeleted = {
    buildConfig = false,
    runningKey = false,
    lastRunningKey = false,
    waitingKey = false,
    timeoutConfig = false,
    deleteKey = false
}

-- Determine what to clean up

-- Convert Redis values to numbers for comparison
local currentRunningId = currentRunningBuildId and tonumber(currentRunningBuildId) or nil
local lastRunningId = lastRunningBuildId and tonumber(lastRunningBuildId) or nil

-- Determine if this build "owns" the running keys
local ownsRunningKey = (currentRunningId == buildIdNum)
local ownsLastRunningKey = (lastRunningId == buildIdNum)

-- Atomically clean up all keys

-- Always delete buildConfig (unconditionally)
if buildConfigExists == 1 then
    redis.call("HDEL", buildConfigKey, buildId)
    keysDeleted.buildConfig = true
end

-- Delete runningKey only if it matches this buildId
if ownsRunningKey then
    redis.call("DEL", runningKey)
    keysDeleted.runningKey = true
end

-- Delete lastRunningKey only if it matches this buildId
if ownsLastRunningKey then
    redis.call("DEL", lastRunningKey)
    keysDeleted.lastRunningKey = true
end

-- Remove from waiting queue (returns count removed)
local waitingRemoved = redis.call("LREM", waitingKey, 0, buildId)
if waitingRemoved > 0 then
    keysDeleted.waitingKey = true
end

-- Delete timeout config (unconditionally)
local timeoutDeleted = redis.call("HDEL", timeoutConfigKey, buildId)
if timeoutDeleted > 0 then
    keysDeleted.timeoutConfig = true
end

-- Delete the deleteKey if it exists
local deleteKeyExists = redis.call("EXISTS", deleteKey)
if deleteKeyExists == 1 then
    redis.call("DEL", deleteKey)
    keysDeleted.deleteKey = true
end

-- Report what was cleaned up

-- Determine action based on what was cleaned
local action = "CLEANED"

if not ownsRunningKey and currentRunningBuildId then
    -- Different build is running now
    action = "NOT_RUNNING"
elseif not keysDeleted.buildConfig and not keysDeleted.runningKey and not keysDeleted.lastRunningKey then
    -- build already cleaned up
    action = "ALREADY_CLEAN"
end

return cjson.encode({
    action = action,
    buildId = buildId,
    jobId = jobId,
    keysDeleted = keysDeleted,
    currentRunningBuildId = currentRunningBuildId,
    ownsRunningKey = ownsRunningKey,
    ownsLastRunningKey = ownsLastRunningKey
})
