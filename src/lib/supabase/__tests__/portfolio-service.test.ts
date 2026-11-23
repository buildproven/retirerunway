import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { User } from '@supabase/supabase-js'
import type { Portfolio, UserProfile } from '@/engine/types'

// Mock Supabase client
const mockSelect = vi.fn()
const mockDelete = vi.fn()
const mockUpsert = vi.fn()
const mockEq = vi.fn()
const mockOrder = vi.fn()
const mockSingle = vi.fn()
const mockGetUser = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: mockGetUser,
    },
    from: mockFrom,
  }),
}))

describe('portfolio-service', () => {
  const mockUser: Partial<User> = {
    id: 'test-user-id',
    email: 'test@example.com',
  }

  const mockPortfolio: Portfolio = {
    id: 'portfolio-1',
    name: 'Test Portfolio',
    accounts: [],
    asOfDate: '2026-01-01',
  }

  const mockUserProfile: UserProfile = {
    currentAge: 65,
    targetRetirementAge: 67,
    annualExpenses: 50000,
  }

  beforeEach(() => {
    vi.clearAllMocks()

    // Default mock implementation - will be overridden per test
    mockGetUser.mockResolvedValue({ data: { user: null } })
  })

  describe('loadPortfolios', () => {
    it('should return empty array when user is not authenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { loadPortfolios } = await import('../portfolio-service')

      const result = await loadPortfolios()

      expect(result).toEqual([])
    })

    it('should load portfolios successfully', async () => {
      const mockSavedPortfolio = {
        id: 'saved-1',
        user_id: 'test-user-id',
        name: 'Test Portfolio',
        portfolio_data: mockPortfolio,
        user_profile: mockUserProfile,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }

      mockGetUser.mockResolvedValue({ data: { user: mockUser } })
      mockSelect.mockReturnValue({ eq: mockEq })
      mockEq.mockReturnValue({ order: mockOrder })
      mockOrder.mockResolvedValue({
        data: [mockSavedPortfolio],
        error: null,
      })
      mockFrom.mockReturnValue({ select: mockSelect })

      const { loadPortfolios } = await import('../portfolio-service')
      const result = await loadPortfolios()

      expect(result).toEqual([mockSavedPortfolio])
    })

    it('should handle database errors gracefully', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const mockError = { message: 'Database connection failed' }

      mockGetUser.mockResolvedValue({ data: { user: mockUser } })
      mockSelect.mockReturnValue({ eq: mockEq })
      mockEq.mockReturnValue({ order: mockOrder })
      mockOrder.mockResolvedValue({
        data: null,
        error: mockError,
      })
      mockFrom.mockReturnValue({ select: mockSelect })

      const { loadPortfolios } = await import('../portfolio-service')
      const result = await loadPortfolios()

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load portfolios')
      )
      expect(result).toEqual([])

      consoleErrorSpy.mockRestore()
    })

    it('should return empty array when data is null', async () => {
      mockGetUser.mockResolvedValue({ data: { user: mockUser } })
      mockSelect.mockReturnValue({ eq: mockEq })
      mockEq.mockReturnValue({ order: mockOrder })
      mockOrder.mockResolvedValue({
        data: null,
        error: null,
      })
      mockFrom.mockReturnValue({ select: mockSelect })

      const { loadPortfolios } = await import('../portfolio-service')
      const result = await loadPortfolios()

      expect(result).toEqual([])
    })
  })

  describe('savePortfolio', () => {
    it('should return null when user is not authenticated', async () => {
      mockGetUser.mockResolvedValue({ data: { user: null } })
      const { savePortfolio } = await import('../portfolio-service')

      const result = await savePortfolio(mockPortfolio, mockUserProfile)

      expect(result).toBeNull()
    })

    it('should save portfolio successfully', async () => {
      const mockSavedPortfolio = {
        id: 'portfolio-1',
        user_id: 'test-user-id',
        name: 'Test Portfolio',
        portfolio_data: mockPortfolio,
        user_profile: mockUserProfile,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }

      mockGetUser.mockResolvedValue({ data: { user: mockUser } })
      mockUpsert.mockReturnValue({ select: mockSelect })
      mockSelect.mockReturnValue({ single: mockSingle })
      mockSingle.mockResolvedValue({
        data: mockSavedPortfolio,
        error: null,
      })
      mockFrom.mockReturnValue({ upsert: mockUpsert })

      const { savePortfolio } = await import('../portfolio-service')
      const result = await savePortfolio(mockPortfolio, mockUserProfile)

      expect(result).toEqual(mockSavedPortfolio)
    })

    it('should handle database errors gracefully', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const mockError = { message: 'Insert failed' }

      mockGetUser.mockResolvedValue({ data: { user: mockUser } })
      mockUpsert.mockReturnValue({ select: mockSelect })
      mockSelect.mockReturnValue({ single: mockSingle })
      mockSingle.mockResolvedValue({
        data: null,
        error: mockError,
      })
      mockFrom.mockReturnValue({ upsert: mockUpsert })

      const { savePortfolio } = await import('../portfolio-service')
      const result = await savePortfolio(mockPortfolio, mockUserProfile)

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save portfolio')
      )
      expect(result).toBeNull()

      consoleErrorSpy.mockRestore()
    })
  })

  describe('deletePortfolio', () => {
    it('should delete portfolio successfully', async () => {
      mockDelete.mockReturnValue({ eq: mockEq })
      mockEq.mockResolvedValue({
        error: null,
      })
      mockFrom.mockReturnValue({ delete: mockDelete })

      const { deletePortfolio } = await import('../portfolio-service')
      const result = await deletePortfolio('portfolio-1')

      expect(result).toBe(true)
    })

    it('should handle database errors gracefully', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      const mockError = { message: 'Delete failed' }

      mockDelete.mockReturnValue({ eq: mockEq })
      mockEq.mockResolvedValue({
        error: mockError,
      })
      mockFrom.mockReturnValue({ delete: mockDelete })

      const { deletePortfolio } = await import('../portfolio-service')
      const result = await deletePortfolio('portfolio-1')

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete portfolio')
      )
      expect(result).toBe(false)

      consoleErrorSpy.mockRestore()
    })
  })
})
