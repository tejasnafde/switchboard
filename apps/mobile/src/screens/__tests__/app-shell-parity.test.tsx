/**
 * Projects shows the saved list while the machine cannot answer, and Settings
 * gathers the app's settings for the switchboard://settings link.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import type { Project } from '@shared/types'
import ProjectsScreen from '../ProjectsScreen'
import SettingsScreen from '../SettingsScreen'
import { renderComponent } from '../../test/render'
import { useSavedProjectsStore } from '../../stores/saved-projects'
import { usePrefsStore } from '../../stores/prefs'
import { useConnectionsStore } from '../../stores/connections'

const mockNavigation = { replace: jest.fn(), navigate: jest.fn(), popToTop: jest.fn() }

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual('react')
  return {
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
    useNavigation: () => mockNavigation,
  }
})
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
jest.mock('../../lib/google-auth', () => ({ getSignedInEmail: async () => 'tejas@example.com' }))

let mockGetProjects: () => Promise<Project[]>
jest.mock('../../stores/connections', () => {
  const { create } = jest.requireActual('zustand')
  return {
    getClient: () => ({ getProjects: () => mockGetProjects(), listWorkspaces: async () => [] }),
    useConnectionsStore: create(() => ({
      demoActive: false,
      configs: [{ id: 'mac' }, { id: 'vm' }],
      status: { mac: 'connected', vm: 'error' },
    })),
  }
})
jest.mock('../../stores/reviews', () => ({
  useReviewsStore: Object.assign(() => 0, { getState: () => ({ refresh: async () => undefined }) }),
}))
jest.mock('../../components/ConnectionTabBar', () => ({ ConnectionTabBar: () => null }))

const project = (name: string): Project => ({ name, path: `/src/${name}`, sessions: [] }) as unknown as Project

async function renderProjects() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = { navigation: mockNavigation as any, route: { params: { connectionId: 'mac', label: 'Mac' } } as any }
  const view = renderComponent(<ProjectsScreen {...props} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return view
}

describe('ProjectsScreen offline', () => {
  beforeEach(() => useSavedProjectsStore.setState({ byConnection: {} }))

  it('shows the saved list, the failure and Retry when the machine cannot answer', async () => {
    useSavedProjectsStore.getState().save('mac', { projects: [project('saved-app')], workspaces: [] })
    mockGetProjects = async () => {
      throw new Error('socket closed')
    }
    const view = await renderProjects()
    expect(view.texts()).toEqual(
      expect.arrayContaining(['Showing saved projects', 'socket closed', 'Retry', 'saved-app']),
    )
  })

  it('drops the note and saves the list once the machine answers', async () => {
    useSavedProjectsStore.getState().save('mac', { projects: [project('saved-app')], workspaces: [] })
    mockGetProjects = async () => [project('live-app')]
    const view = await renderProjects()
    expect(view.texts()).toContain('live-app')
    expect(view.texts()).not.toContain('Showing saved projects')
    expect(useSavedProjectsStore.getState().byConnection.mac.projects.map((p) => p.name)).toEqual(['live-app'])
  })

  it('does not save an answer that lands after the machine was unpaired', async () => {
    const configs = useConnectionsStore.getState().configs
    let answer!: (projects: Project[]) => void
    mockGetProjects = () => new Promise((resolve) => (answer = resolve))
    await renderProjects()
    useConnectionsStore.setState({ configs: configs.filter((c) => c.id !== 'mac') })
    await act(async () => {
      answer([project('late-app')])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useSavedProjectsStore.getState().byConnection.mac).toBeUndefined()
    useConnectionsStore.setState({ configs })
  })
})

describe('SettingsScreen', () => {
  it('has the live pages switch, off by default', async () => {
    expect(usePrefsStore.getState().liveHtmlPages).toBe(false)
    const view = renderComponent(<SettingsScreen />)
    const toggle = view.root.find(
      (n) => n.props.testID === 'settings-phone_html_live_run' && typeof n.type === 'string',
    )
    expect(toggle.props.value).toBe(false)
    await act(async () => {
      view.byLabel('Run live pages').props.onValueChange?.(true)
      await Promise.resolve()
    })
    expect(usePrefsStore.getState().liveHtmlPages).toBe(true)
  })

  it('lists the account, the follow-up default and the build', async () => {
    usePrefsStore.setState({ followUpDefault: 'steer' })
    const view = renderComponent(<SettingsScreen />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        'Account',
        'Google account',
        'tejas@example.com',
        'Machines',
        '1 of 2 live',
        'Chat',
        'Follow-up while the agent works',
      ]),
    )
    expect(view.root.findAllByProps({ testID: 'settings-leave-demo' })).toEqual([])
    act(() => view.root.findByProps({ testID: 'follow-up-queue' }).props.onPress())
    expect(usePrefsStore.getState().followUpDefault).toBe('queue')
    act(() => view.root.findByProps({ testID: 'settings-google-account' }).props.onPress())
    expect(mockNavigation.navigate).toHaveBeenCalledWith('SignIn')
    act(() => view.root.findByProps({ testID: 'settings-machines' }).props.onPress())
    expect(mockNavigation.popToTop).toHaveBeenCalled()
  })
})
