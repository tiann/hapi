import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

async function countMagentaPixels(page: Page, bytes: Buffer): Promise<number> {
    return page.evaluate(async (base64) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Missing canvas context')
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let count = 0
        for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] > 220 && pixels[index + 1] < 80 && pixels[index + 2] > 130) count += 1
        }
        return count
    }, bytes.toString('base64'))
}

async function exportPng(page: Page, outputPath: string): Promise<Buffer> {
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('dialog').getByRole('button', { name: /^(Download|下载)$/ }).click()
    const download = await downloadPromise
    await download.saveAs(outputPath)
    return readFile(outputPath)
}

async function openBlobFixture(page: Page, mode: 'blob' | 'data'): Promise<void> {
    const blobMode = mode === 'data' ? '&blobMode=data' : ''
    await page.goto(`/e2e-fixtures/share-turn-fixture.html?blobImage=1&inlineWrap=1${blobMode}`)
    const sourceImage = page.getByTestId('source-turn').getByAltText('Blob export fixture')
    await expect(sourceImage).toHaveAttribute('src', mode === 'data' ? /^data:/ : /^blob:/)
    await expect.poll(() => sourceImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    await page.getByRole('button', { name: 'Open share preview' }).click()
    const previewImage = page.getByRole('dialog').getByAltText('Blob export fixture')
    await expect(previewImage).toBeVisible()
    await expect.poll(() => previewImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
}

test('preserves blob images in inline-code share exports', async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 2200 })
    await openBlobFixture(page, 'blob')
    await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('preview-blob.png') })

    const blobBytes = await exportPng(page, testInfo.outputPath('export-blob.png'))
    const blobMagentaPixels = await countMagentaPixels(page, blobBytes)

    await openBlobFixture(page, 'data')
    const dataBytes = await exportPng(page, testInfo.outputPath('export-data.png'))
    const dataMagentaPixels = await countMagentaPixels(page, dataBytes)

    console.log(`blob_magenta_pixels=${blobMagentaPixels} data_magenta_pixels=${dataMagentaPixels}`)
    expect(blobBytes.subarray(1, 4).toString()).toBe('PNG')
    expect(dataBytes.subarray(1, 4).toString()).toBe('PNG')
    expect(blobMagentaPixels).toBeGreaterThan(10_000)
    expect(dataMagentaPixels).toBeGreaterThan(10_000)
})