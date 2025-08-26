import type { ExuluFieldTypes } from "../enums/field-types"

export interface Context {
    id: string
    name: string
    description: string
    embedder: string
    active: boolean
    slug: string
    fields: {
      name: string
      type: ExuluFieldTypes
      label: string
    }[]
  }