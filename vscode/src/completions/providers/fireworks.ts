import {
    type AuthenticatedAuthStatus,
    type CodeCompletionsParams,
    type CompletionResponseGenerator,
    currentAuthStatusAuthed,
    currentResolvedConfig,
    dotcomTokenToGatewayToken,
    isDotCom,
    isDotComAuthed,
    tokensToChars,
} from '@sourcegraph/cody-shared'
import { defaultCodeCompletionsClient } from '../default-client'
import { createFastPathClient } from '../fast-path-client'
import { TriggerKind } from '../get-inline-completions'
import { forkSignal, generatorWithTimeout, zipGenerators } from '../utils'
import {
    type FetchCompletionResult,
    fetchAndProcessDynamicMultilineCompletions,
} from './shared/fetch-and-process-completions'
import {
    type CompletionProviderTracer,
    type GenerateCompletionsOptions,
    MAX_RESPONSE_TOKENS,
    Provider,
    type ProviderFactoryParams,
} from './shared/provider'

export const FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V0 = 'deepseek-finetuned-lang-specific-v0'
export const FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V1 = 'deepseek-finetuned-lang-specific-v1'
export const FIREWORKS_DEEPSEEK_7B_LANG_ALL = 'deepseek-finetuned-lang-all-v0'

export const DEEPSEEK_CODER_V2_LITE_BASE = 'deepseek-coder-v2-lite-base'

// Context window experiments with DeepSeek Model
export const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096 = 'deepseek-coder-v2-lite-base-context-4096'
const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192 = 'deepseek-coder-v2-lite-base-context-8192'
const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384 = 'deepseek-coder-v2-lite-base-context-16383'
const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768 = 'deepseek-coder-v2-lite-base-context-32768'

// Model identifiers can be found in https://docs.fireworks.ai/explore/ and in our internal
// conversations
const MODEL_MAP = {
    // Virtual model strings. Cody Gateway will map to an actual model
    starcoder: 'fireworks/starcoder',
    'starcoder-16b': 'fireworks/starcoder-16b',
    'starcoder-7b': 'fireworks/starcoder-7b',

    // Fireworks model identifiers
    'llama-code-13b': 'fireworks/accounts/fireworks/models/llama-v2-13b-code',

    [FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V0]: 'fireworks/finetuned-fim-lang-specific-model-ds2-v0',
    [FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V1]: 'fireworks/finetuned-fim-lang-specific-model-ds2-v1',
    [FIREWORKS_DEEPSEEK_7B_LANG_ALL]: 'accounts/sourcegraph/models/finetuned-fim-lang-all-model-ds2-v0',
    [DEEPSEEK_CODER_V2_LITE_BASE]: 'fireworks/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096]: 'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192]: 'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384]:
        'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768]:
        'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
} as const

type FireworksModel =
    | keyof typeof MODEL_MAP
    // `starcoder-hybrid` uses the 16b model for multiline requests and the 7b model for single line
    | 'starcoder-hybrid'

function getMaxContextTokens(model: FireworksModel): number {
    switch (model) {
        case 'starcoder':
        case 'starcoder-hybrid':
        case 'starcoder-16b':
        case 'starcoder-7b': {
            // StarCoder supports up to 8k tokens, we limit it to ~2k for evaluation against
            // other providers.
            return 2048
        }
        case 'llama-code-13b':
            // Llama 2 on Fireworks supports up to 4k tokens. We're constraining it here to better
            // compare the results
            return 2048
        case FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V0:
        case FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V1:
        case FIREWORKS_DEEPSEEK_7B_LANG_ALL:
        case DEEPSEEK_CODER_V2_LITE_BASE: {
            return 2048
        }
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096:
            return 4096
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192:
            return 8192
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384:
            return 16384
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768:
            return 32768
        default:
            return 1200
    }
}

class FireworksProvider extends Provider {
    public getRequestParams(options: GenerateCompletionsOptions): CodeCompletionsParams {
        const { multiline, docContext, document, triggerKind, snippets } = options
        const useMultilineModel = multiline || triggerKind !== TriggerKind.Automatic

        const model =
            this.legacyModel === 'starcoder-hybrid'
                ? MODEL_MAP[useMultilineModel ? 'starcoder-16b' : 'starcoder-7b']
                : MODEL_MAP[this.legacyModel as keyof typeof MODEL_MAP]

        const messages = this.modelHelper.getMessages({
            snippets,
            docContext,
            document,
            promptChars: tokensToChars(this.maxContextTokens - MAX_RESPONSE_TOKENS),
        })

        return this.modelHelper.getRequestParams({
            ...this.defaultRequestParams,
            messages,
            model,
        })
    }
    public async generateCompletions(
        generateOptions: GenerateCompletionsOptions,
        abortSignal: AbortSignal,
        tracer?: CompletionProviderTracer
    ): Promise<AsyncGenerator<FetchCompletionResult[]>> {
        const { docContext, numberOfCompletionsToGenerate } = generateOptions

        const requestParams = this.getRequestParams(generateOptions)
        tracer?.params(requestParams)

        const completionsGenerators = Array.from({ length: numberOfCompletionsToGenerate }).map(
            async () => {
                const abortController = forkSignal(abortSignal)

                const completionResponseGenerator = generatorWithTimeout(
                    await this.createClient(generateOptions, requestParams, abortController),
                    requestParams.timeoutMs,
                    abortController
                )

                return fetchAndProcessDynamicMultilineCompletions({
                    completionResponseGenerator,
                    abortController,
                    generateOptions,
                    providerSpecificPostProcess: content =>
                        this.modelHelper.postProcess(content, docContext),
                })
            }
        )

        /**
         * This implementation waits for all generators to yield values
         * before passing them to the consumer (request-manager). While this may appear
         * as a performance bottleneck, it's necessary for the current design.
         *
         * The consumer operates on promises, allowing only a single resolve call
         * from `requestManager.request`. Therefore, we must wait for the initial
         * batch of completions before returning them collectively, ensuring all
         * are included as suggested completions.
         *
         * To circumvent this performance issue, a method for adding completions to
         * the existing suggestion list is needed. Presently, this feature is not
         * available, and the switch to async generators maintains the same behavior
         * as with promises.
         */
        return zipGenerators(await Promise.all(completionsGenerators))
    }

    private getCustomHeaders(isFireworksTracingEnabled?: boolean): Record<string, string> {
        // Enabled Fireworks tracing for Sourcegraph teammates.
        // https://readme.fireworks.ai/docs/enabling-tracing
        const customHeaders: Record<string, string> = {}

        if (isFireworksTracingEnabled) {
            customHeaders['X-Fireworks-Genie'] = 'true'
        }

        return customHeaders
    }

    private async createClient(
        options: GenerateCompletionsOptions,
        requestParams: CodeCompletionsParams,
        abortController: AbortController
    ): Promise<CompletionResponseGenerator> {
        const authStatus = currentAuthStatusAuthed()
        const config = await currentResolvedConfig()

        const isLocalInstance = Boolean(
            authStatus.endpoint?.includes('sourcegraph.test') ||
                authStatus.endpoint?.includes('localhost')
        )

        const isNode = typeof process !== 'undefined'
        let fastPathAccessToken =
            config.auth.accessToken &&
            // Require the upstream to be dotcom
            (isDotComAuthed() || isLocalInstance) &&
            process.env.CODY_DISABLE_FASTPATH !== 'true' && // Used for testing
            // The fast path client only supports Node.js style response streams
            isNode
                ? dotcomTokenToGatewayToken(config.auth.accessToken)
                : undefined

        if (fastPathAccessToken) {
            const useExperimentalFireworksConfig =
                process.env.NODE_ENV === 'development' &&
                config.configuration.autocompleteExperimentalFireworksOptions?.token

            if (useExperimentalFireworksConfig) {
                fastPathAccessToken =
                    config.configuration.autocompleteExperimentalFireworksOptions?.token
            }

            return createFastPathClient(requestParams, abortController, {
                isLocalInstance,
                fireworksConfig: useExperimentalFireworksConfig
                    ? config.configuration.autocompleteExperimentalFireworksOptions
                    : undefined,
                logger: defaultCodeCompletionsClient.instance!.logger,
                providerOptions: options,
                fastPathAccessToken,
                fireworksCustomHeaders: this.getCustomHeaders(authStatus.isFireworksTracingEnabled),
            })
        }

        return await this.client.complete(requestParams, abortController, {
            customHeaders: this.getCustomHeaders(authStatus.isFireworksTracingEnabled),
        })
    }
}

function getClientModel(
    model: string | undefined,
    authStatus: Pick<AuthenticatedAuthStatus, 'endpoint'>
): FireworksModel {
    if (model === undefined || model === '') {
        return isDotCom(authStatus) ? DEEPSEEK_CODER_V2_LITE_BASE : 'starcoder-hybrid'
    }

    if (model === 'starcoder-hybrid' || Object.prototype.hasOwnProperty.call(MODEL_MAP, model)) {
        return model as FireworksModel
    }

    throw new Error(`Unknown model: \`${model}\``)
}

export function createProvider({ legacyModel, source, authStatus }: ProviderFactoryParams): Provider {
    const clientModel = getClientModel(legacyModel, authStatus)

    return new FireworksProvider({
        id: 'fireworks',
        legacyModel: clientModel,
        maxContextTokens: getMaxContextTokens(clientModel),
        source,
    })
}
