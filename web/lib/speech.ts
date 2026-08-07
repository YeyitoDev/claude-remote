'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Dictado por voz con la API del navegador.
 *
 * El audio no pasa por Claude Remote ni por el modelo: lo transcribe el propio
 * navegador, así que no cuesta tokens ni añade latencia al servidor. A cambio
 * no está en todas partes —Firefox no lo trae—, de ahí que el hook diga si
 * está soportado para poder esconder el botón en vez de ofrecer algo roto.
 */

type SpeechEvent = {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: SpeechEvent) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => Recognition) | null
}

export function useDictation(onPhrase: (text: string) => void) {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<Recognition | null>(null)

  // El callback cambia en cada render del composer; la referencia evita tener
  // que recrear el reconocedor por eso.
  const onPhraseRef = useRef(onPhrase)
  onPhraseRef.current = onPhrase

  // En un efecto y no en el render: el HTML es estático y leer `window` al
  // renderizar rompería la hidratación.
  useEffect(() => setSupported(recognitionCtor() !== null), [])

  const stop = useCallback(() => {
    recRef.current?.stop()
    setListening(false)
  }, [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    setError(null)

    const rec = new Ctor()
    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'es-ES'
    rec.continuous = true
    // Solo frases cerradas: lo interino se reescribe a cada sílaba y en un
    // textarea que ya tiene texto queda ilegible.
    rec.interimResults = false

    rec.onresult = (event) => {
      let phrase = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) phrase += result[0].transcript
      }
      if (phrase.trim()) onPhraseRef.current(phrase.trim())
    }

    rec.onerror = (event) => {
      const code = event?.error
      setError(
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Sin permiso para el micrófono.'
          : code === 'no-speech'
            ? 'No se oyó nada.'
            : code === 'network'
              ? 'El dictado necesita conexión.'
              : 'El dictado falló.',
      )
      setListening(false)
    }

    rec.onend = () => setListening(false)

    recRef.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      setError('No se pudo abrir el micrófono.')
    }
  }, [])

  // Salir de la sesión con el micro abierto lo dejaría escuchando.
  useEffect(() => () => recRef.current?.abort(), [])

  return {
    supported,
    listening,
    error,
    toggle: () => (listening ? stop() : start()),
    stop,
  }
}
