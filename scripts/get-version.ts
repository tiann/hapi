#!/usr/bin/env bun
/**
 * Get version information for build
 * Outputs JSON with git SHA, git-describe, dirty state, and build timestamp
 */

import { $ } from 'bun'

async function getVersion() {
    try {
        // Get full git SHA
        const sha = await $`git rev-parse HEAD`.text()
        const shortSha = sha.trim().substring(0, 7)

        // Get git branch
        const branch = await $`git rev-parse --abbrev-ref HEAD`.text()

        // Check if working directory is clean
        const status = await $`git status --porcelain`.text()
        const isDirty = status.trim().length > 0

        // Get git describe output (includes tags and dirty state)
        let gitDescribe = ''
        try {
            gitDescribe = await $`git describe --tags --always --dirty`.text()
            gitDescribe = gitDescribe.trim()
        } catch {
            // If no tags exist, git describe falls back to abbreviated SHA
            // If that fails too, use shortSha
            gitDescribe = shortSha
        }

        // Get commit timestamp
        const commitTime = await $`git log -1 --format=%cI`.text()

        const version = {
            sha: sha.trim(),
            shortSha,
            branch: branch.trim(),
            isDirty,
            gitDescribe,
            commitTime: commitTime.trim(),
            buildTime: new Date().toISOString(),
        }

        return version
    } catch (error) {
        console.error('Failed to get git version info:', error)
        // Return fallback version
        return {
            sha: 'unknown',
            shortSha: 'unknown',
            branch: 'unknown',
            isDirty: false,
            gitDescribe: 'unknown',
            commitTime: new Date().toISOString(),
            buildTime: new Date().toISOString(),
        }
    }
}

// Run and output
const version = await getVersion()
console.log(JSON.stringify(version, null, 2))
