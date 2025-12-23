--[[
    checkTimeout.lua - Atomic timeout check

    This script atomically checks if a build has timed out and takes appropriate action.

    ARGV[1]  = buildId (string)
    ARGV[2]  = jobId (string)
    ARGV[3]  = startTime (number, milliseconds timestamp)
    ARGV[4]  = timeoutMinutes (number)
    ARGV[5]  = currentTime (number, milliseconds timestamp)
    ARGV[6]  = queuePrefix (string)
    ARGV[7]  = runningJobsPrefix (string)
    ARGV[8]  = waitingJobsPrefix (string)

    Returns: JSON string with decision
    {
        action: "TIMEOUT" | "CLEANUP" | "SKIP",
        reason: string,
        buildId: string,
        data: {...}
    }
]]

local buildId = ARGV[1]
local jobId = ARGV[2]
local startTime = tonumber(ARGV[3])
local timeoutMinutes = tonumber(ARGV[4])
local currentTime = tonumber(ARGV[5])
local queuePrefix = ARGV[6]
local runningJobsPrefix = ARGV[7]
local waitingJobsPrefix = ARGV[8]

local buildConfigKey = queuePrefix .. "buildConfigs"
local timeoutConfigKey = queuePrefix .. "timeoutConfigs"
local runningKey = runningJobsPrefix .. jobId
local lastRunningKey = "last_" .. runningJobsPrefix .. jobId
local waitingKey = waitingJobsPrefix .. jobId
local deleteKey = "deleted_" .. jobId .. "_" .. buildId

local buildConfig = redis.call("HGET", buildConfigKey, buildId)
local currentRunningBuildId = redis.call("GET", runningKey)
local buildConfigExists = (buildConfig ~= false)

-- Helper: Check if timed out
local function hasTimedOut()
    if not startTime then
        return false, 0, timeoutMinutes, "NO_START_TIME"
    end

    local bufferMinutes = 1
    local elapsedMs = currentTime - startTime
    local elapsedMinutes = math.floor(elapsedMs / 60000 + 0.5)
    local effectiveTimeout = timeoutMinutes + bufferMinutes

    local timedOut = elapsedMinutes > effectiveTimeout

    return timedOut, elapsedMinutes, effectiveTimeout,
           (timedOut and "TIMEOUT_EXCEEDED" or "WITHIN_TIMEOUT")
end

-- Helper: Check if eligible for timeout
local function isEligibleForTimeout()
    local buildIdNum = tonumber(buildId)

    -- Build config deleted = already completed
    if not buildConfigExists then
        return false, "BUILD_COMPLETED", true
    end

    -- Different build running = not running anymore
    if currentRunningBuildId then
        local runningId = tonumber(currentRunningBuildId)
        if runningId ~= buildIdNum then
            return false, "NOT_RUNNING", true
        end

        -- Running build matches = eligible
        if runningId == buildIdNum then
            return true, "ELIGIBLE", false
        end
    end

    -- No running build = not running
    return false, "NO_RUNNING_BUILD", true
end

-- check timeout status
local timedOut, elapsedMinutes, effectiveTimeout, timeoutReason = hasTimedOut()
local eligible, eligibleReason, shouldCleanup = isEligibleForTimeout()

-- Determine action
local action, reason, actionData

if not eligible then
    if shouldCleanup then
        action = "CLEANUP"
        reason = eligibleReason
        actionData = {shouldCleanup = true}
    else
        action = "SKIP"
        reason = eligibleReason
    end
elseif timedOut then
    action = "TIMEOUT"
    reason = "BUILD_TIMEOUT"
    actionData = {
        elapsedMinutes = elapsedMinutes,
        timeoutMinutes = effectiveTimeout
    }
else
    action = "SKIP"
    reason = "WITHIN_TIMEOUT"
    actionData = {
        elapsedMinutes = elapsedMinutes,
        timeoutMinutes = effectiveTimeout
    }
end

-- update redis state based on action
if action == "CLEANUP" then
    -- Clean up stale timeout config
    redis.call("HDEL", timeoutConfigKey, buildId)

    return cjson.encode({
        action = "CLEANUP",
        reason = reason,
        buildId = buildId
    })

elseif action == "TIMEOUT" then
    -- Build has timed out - clean up all keys

    -- Remove build config
    redis.call("HDEL", buildConfigKey, buildId)

    -- Expire running keys immediately
    redis.call("EXPIRE", runningKey, 0)
    redis.call("EXPIRE", lastRunningKey, 0)

    -- Remove from waiting queue (if present)
    redis.call("LREM", waitingKey, 0, buildId)

    -- Delete deleteKey
    redis.call("DEL", deleteKey)

    -- Remove timeout config
    redis.call("HDEL", timeoutConfigKey, buildId)

    return cjson.encode({
        action = "TIMEOUT",
        reason = reason,
        buildId = buildId,
        elapsedMinutes = actionData.elapsedMinutes,
        timeoutMinutes = actionData.timeoutMinutes
    })

else  -- SKIP
    -- No action needed
    return cjson.encode({
        action = "SKIP",
        reason = reason,
        buildId = buildId,
        elapsedMinutes = actionData and actionData.elapsedMinutes or nil,
        timeoutMinutes = actionData and actionData.timeoutMinutes or nil
    })
end
