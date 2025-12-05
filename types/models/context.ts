import type { ExuluFieldTypes } from "../enums/field-types"
import { allFileTypes } from "../../src/registry/classes"

export interface Context {
  id: string
  name: string
  description: string
  embedder?: {
    name: string,
    queue: string,
    id: string,
    config?: {
      name: string,
      description: string,
      default: string
    }[]
  }
  active: boolean
  slug: string
  processors: {
    field: string
    description: string
    queue: string
    trigger: string
    timeoutInSeconds: number
    generateEmbeddings: boolean
  }[]
  sources: {
    id
    name
    description
    config: {
      schedule?: string
      queue?: string
      retries?: number
      params?: {
        name: string,
        description: string,
        default: string
      }[]
      backoff?: {
        type: 'exponential' | 'linear'
        delay: number
      }
    }
  }[]
  fields: {
    name: string
    type: ExuluFieldTypes
    label: string
    allowedFileTypes?: allFileTypes[]
  }[]
}