import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(__dirname, '..')
const repoRoot = join(desktopRoot, '..')
const sourceTemplatePath = join(desktopRoot, 'build', 'portable.nsi')
const targetTemplatePath = join(repoRoot, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'portable.nsi')

if (!existsSync(sourceTemplatePath)) {
    throw new Error(`portable template not found: ${sourceTemplatePath}`)
}

if (!existsSync(targetTemplatePath)) {
    throw new Error(`electron-builder portable template not found: ${targetTemplatePath}`)
}

copyFileSync(sourceTemplatePath, targetTemplatePath)
console.log(`Patched electron-builder portable template: ${targetTemplatePath}`)
