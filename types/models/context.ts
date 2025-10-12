import type { ExuluFieldTypes } from "../enums/field-types"
import { allFileTypes } from "../../src/registry/classes"

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
      allowedFileTypes?: allFileTypes[]
    }[]
  }