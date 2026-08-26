import { useAppStore } from '../../stores/appStore';
import { HomeScreen } from '../home/HomeScreen';
import { GameLayout } from './GameLayout';

export function MainLayout() {
  const screen = useAppStore((s) => s.screen);

  if (screen === 'home') return <HomeScreen />;
  return <GameLayout />;
}
