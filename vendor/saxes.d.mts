// The subset of Saxes' namespace-aware API used by the JUnit reader.
export interface SaxesTagNS {
  local: string
  attributes: Record<string, { value: string } | undefined>
}

interface SaxesEvents {
  error: (error: Error) => void
  doctype: (declaration: string) => void
  opentag: (tag: SaxesTagNS) => void
  closetag: (tag: SaxesTagNS) => void
  text: (text: string) => void
  cdata: (text: string) => void
}

export class SaxesParser {
  constructor(options: { xmlns: true })
  on<Event extends keyof SaxesEvents>(event: Event, handler: SaxesEvents[Event]): void
  write(xml: string): this
  close(): this
}
