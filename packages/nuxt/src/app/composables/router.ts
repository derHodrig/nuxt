import { getCurrentInstance, inject, onUnmounted } from 'vue'
import type { Ref } from 'vue'
import type { NavigationFailure, NavigationGuard, RouteLocationNormalized, RouteLocationNormalizedLoaded, RouteLocationPathRaw, RouteLocationRaw, Router } from 'vue-router'
import { sendRedirect } from 'h3'
import { hasProtocol, joinURL, parseURL } from 'ufo'

import { useNuxtApp, useRuntimeConfig } from '../nuxt'
import type { NuxtError } from './error'
import { createError } from './error'
import { useState } from './state'

import type { PageMeta } from '#app'

export const useRouter = () => {
  return useNuxtApp()?.$router as Router
}

export const useRoute = (): RouteLocationNormalizedLoaded => {
  if (process.dev && isProcessingMiddleware()) {
    console.warn('[nuxt] Calling `useRoute` within middleware may lead to misleading results. Instead, use the (to, from) arguments passed to the middleware to access the new and old routes.')
  }
  if (getCurrentInstance()) {
    return inject('_route', useNuxtApp()._route)
  }
  return useNuxtApp()._route
}

export const onBeforeRouteLeave = (guard: NavigationGuard) => {
  const unsubscribe = useRouter().beforeEach((to, from, next) => {
    if (to === from) { return }
    return guard(to, from, next)
  })
  onUnmounted(unsubscribe)
}

export const onBeforeRouteUpdate = (guard: NavigationGuard) => {
  const unsubscribe = useRouter().beforeEach(guard)
  onUnmounted(unsubscribe)
}

export interface RouteMiddleware {
  (to: RouteLocationNormalized, from: RouteLocationNormalized): ReturnType<NavigationGuard>
}

export const defineNuxtRouteMiddleware = (middleware: RouteMiddleware) => middleware

export interface AddRouteMiddlewareOptions {
  global?: boolean
}

interface AddRouteMiddleware {
  (name: string, middleware: RouteMiddleware, options?: AddRouteMiddlewareOptions): void
  (middleware: RouteMiddleware): void
}

export const addRouteMiddleware: AddRouteMiddleware = (name: string | RouteMiddleware, middleware?: RouteMiddleware, options: AddRouteMiddlewareOptions = {}) => {
  const nuxtApp = useNuxtApp()
  const global = options.global || typeof name !== 'string'
  const mw = typeof name !== 'string' ? name : middleware
  if (!mw) {
    console.warn('[nuxt] No route middleware passed to `addRouteMiddleware`.', name)
    return
  }
  if (global) {
    nuxtApp._middleware.global.push(mw)
  } else {
    nuxtApp._middleware.named[name] = mw
  }
}

const isProcessingMiddleware = () => {
  try {
    if (useNuxtApp()._processingMiddleware) {
      return true
    }
  } catch {
    // Within an async middleware
    return true
  }
  return false
}

export interface NavigateToOptions {
  replace?: boolean
  redirectCode?: number,
  external?: boolean
}

export const navigateTo = (to: RouteLocationRaw | undefined | null, options?: NavigateToOptions): Promise<void | NavigationFailure | false> | RouteLocationRaw => {
  if (!to) {
    to = '/'
  }

  const toPath = typeof to === 'string' ? to : ((to as RouteLocationPathRaw).path || '/')
  const isExternal = options?.external || hasProtocol(toPath, { acceptRelative: true })
  if (isExternal && !options?.external) {
    throw new Error('Navigating to external URL is not allowed by default. Use `navigateTo (url, { external: true })`.')
  }
  if (isExternal && parseURL(toPath).protocol === 'script:') {
    throw new Error('Cannot navigate to an URL with script protocol.')
  }

  const inMiddleware = isProcessingMiddleware()

  // Early redirect on client-side
  if (process.client && !isExternal && inMiddleware) {
    return to
  }

  const router = useRouter()

  if (process.server) {
    const nuxtApp = useNuxtApp()
    if (nuxtApp.ssrContext && nuxtApp.ssrContext.event) {
      const fullPath = typeof to === 'string' || isExternal ? toPath : router.resolve(to).fullPath || '/'
      const redirectLocation = isExternal ? toPath : joinURL(useRuntimeConfig().app.baseURL, fullPath)
      const redirect = () => nuxtApp.callHook('app:redirected')
        .then(() => sendRedirect(nuxtApp.ssrContext!.event, redirectLocation, options?.redirectCode || 302))
        .then(() => inMiddleware ? /* abort route navigation */ false : undefined)

      // We wait to perform the redirect in case any other middleware will intercept the redirect
      // and redirect further.
      if (!isExternal && inMiddleware) {
        router.beforeEach(final => (final.fullPath === fullPath) ? redirect() : undefined)
        return to
      }
      return redirect()
    }
  }

  // Client-side redirection using vue-router
  if (isExternal) {
    if (options?.replace) {
      location.replace(toPath)
    } else {
      location.href = toPath
    }
    return Promise.resolve()
  }

  return options?.replace ? router.replace(to) : router.push(to)
}

/** This will abort navigation within a Nuxt route middleware handler. */
export const abortNavigation = (err?: string | Partial<NuxtError>) => {
  if (process.dev && !isProcessingMiddleware()) {
    throw new Error('abortNavigation() is only usable inside a route middleware handler.')
  }
  if (err) {
    throw createError(err)
  }
  return false
}

export const setPageLayout = (layout: string) => {
  if (process.server) {
    if (process.dev && getCurrentInstance() && useState('_layout').value !== layout) {
      console.warn('[warn] [nuxt] `setPageLayout` should not be called to change the layout on the server within a component as this will cause hydration errors.')
    }
    useState('_layout').value = layout
  }
  const nuxtApp = useNuxtApp()
  if (process.dev && nuxtApp.isHydrating && nuxtApp.payload.serverRendered && useState('_layout').value !== layout) {
    console.warn('[warn] [nuxt] `setPageLayout` should not be called to change the layout during hydration as this will cause hydration errors.')
  }
  const inMiddleware = isProcessingMiddleware()
  if (inMiddleware || process.server || nuxtApp.isHydrating) {
    const unsubscribe = useRouter().beforeResolve((to) => {
      to.meta.layout = layout as Exclude<PageMeta['layout'], Ref | false>
      unsubscribe()
    })
  }
  if (!inMiddleware) {
    useRoute().meta.layout = layout as Exclude<PageMeta['layout'], Ref | false>
  }
}
