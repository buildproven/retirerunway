import { describe, expect, it } from 'vitest'
import {
  ISSUER_ENV,
  JWKS_URL_ENV,
  OWNER_SUBJECT_ENV,
  readAuthConfig,
  readIssuer,
} from '../http-auth'

const env = (issuer: string) => ({
  [ISSUER_ENV]: issuer,
  [JWKS_URL_ENV]: 'https://runway.example.com/oauth/jwks',
  [OWNER_SUBJECT_ENV]: 'owner-1',
})

describe('issuer setting', () => {
  it('drops trailing slashes, matching the iss the authorization server signs', () => {
    for (const issuer of [
      'https://runway.example.com',
      'https://runway.example.com/',
      'https://runway.example.com//',
    ]) {
      const issued = readIssuer(env(issuer))
      const config = readAuthConfig(env(issuer))
      expect(issued.ok && issued.value).toBe('https://runway.example.com')
      expect(config.ok && config.value.issuer).toBe(
        'https://runway.example.com'
      )
    }
  })
})
