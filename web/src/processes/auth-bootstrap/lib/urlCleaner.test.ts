import { describe, expect, it, vi } from 'vitest'
import { cleanAuthParams } from './urlCleaner'

describe('cleanAuthParams', () => {
  it('当没有认证参数时返回 shouldClean: false', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?foo=bar',
      hash: '#section'
    })

    expect(result.shouldClean).toBe(false)
    expect(result.nextHref).toBe('')
  })

  it('检测 server 参数并清理', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?server=http://example.com&foo=bar',
      hash: '#section'
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions?foo=bar#section')
  })

  it('检测 hub 参数并清理', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?hub=test-hub',
      hash: ''
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions')
  })

  it('检测 token 参数并清理', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?token=abc123',
      hash: ''
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions')
  })

  it('同时清理多个认证参数', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?server=http://example.com&hub=test-hub&token=abc123&other=value',
      hash: '#section'
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions?other=value#section')
  })

  it('清理所有认证参数后保留其他参数', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?server=http://example.com&foo=bar&baz=qux',
      hash: ''
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions?foo=bar&baz=qux')
  })

  it('当只有认证参数时返回干净的 URL', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?server=http://example.com',
      hash: ''
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions')
  })

  it('保留 hash 部分', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?server=http://example.com',
      hash: '#top'
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions#top')
  })

  it('处理空 search 参数', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '',
      hash: ''
    })

    expect(result.shouldClean).toBe(false)
    expect(result.nextHref).toBe('')
  })

  it('处理 state 参数（不使用）', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?server=http://example.com',
      hash: '',
      state: { some: 'state' }
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions')
  })

  it('server 参数值为空时也清理', () => {
    const result = cleanAuthParams({
      pathname: '/sessions',
      search: '?server=',
      hash: ''
    })

    expect(result.shouldClean).toBe(true)
    expect(result.nextHref).toBe('/sessions')
  })
})
