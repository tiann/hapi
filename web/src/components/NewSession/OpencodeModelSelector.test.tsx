import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { OpencodeModelSelector } from './OpencodeModelSelector'

describe('OpencodeModelSelector', () => {
    it('uses the shared combobox interaction for discovered models', () => {
        const onModelChange = vi.fn()
        render(<I18nProvider>
            <OpencodeModelSelector
                cwd="/project"
                machineId="machine-1"
                isLoading={false}
                error={null}
                availableModels={[{ modelId: 'openai/gpt-5.4', name: 'GPT-5.4' }]}
                currentModelId="openai/gpt-5.4"
                selectedModel={null}
                onModelChange={onModelChange}
            />
        </I18nProvider>)

        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'openai/gpt-5.4' } })
        expect(onModelChange).toHaveBeenCalledWith('openai/gpt-5.4')
    })
})
