import path from 'node:path'

import type { QueryCapture, QueryMatch } from 'web-tree-sitter'

import { SupportedLanguage } from './grammars'
import { type WrappedParser, createParser } from './parser'
import { type DocumentQuerySDK, getDocumentQuerySDK } from './query-sdk'

const CUSTOM_WASM_LANGUAGE_DIR = path.join(__dirname, '../../resources/wasm')

/**
 * Should be used in tests only.
 */
export function initTreeSitterParser(
    language = SupportedLanguage.typescript
): Promise<WrappedParser | undefined> {
    return createParser({
        language,
        grammarDirectory: CUSTOM_WASM_LANGUAGE_DIR,
    })
}

/**
 * Should be used in tests only.
 */
export async function initTreeSitterSDK(
    language = SupportedLanguage.typescript
): Promise<DocumentQuerySDK> {
    await initTreeSitterParser(language)
    const sdk = getDocumentQuerySDK(language)

    if (!sdk) {
        throw new Error('Document query SDK is not initialized')
    }

    return sdk
}

interface FormattedMatch {
    pattern: number
    captures: FormattedCapture[]
}

export function formatMatches(matches: QueryMatch[]): FormattedMatch[] {
    return matches.map(({ pattern, captures }) => ({
        pattern,
        captures: formatCaptures(captures),
    }))
}

interface FormattedCapture {
    name: string
    text: string
}

function formatCaptures(captures: QueryCapture[]): FormattedCapture[] {
    return captures.map(capture => ({
        name: capture.name,
        text: capture.node.text,
        start: capture.node.startPosition,
        end: capture.node.endPosition,
    }))
}
