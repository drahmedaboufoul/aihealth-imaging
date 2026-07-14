/**
 * IOS Viewer Pro - Toolbar Component
 * Main toolbar with tool selection and view controls
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Move3d,
  Ruler,
  RotateCcw,
  Scissors,
  MessageSquare,
  GitCompare,
  Grid3X3,
  Box,
  Eye,
  Sun,
  Moon,
  Target,
  Save
} from 'lucide-react';
import { useIOSViewerStore } from '../store/iosViewerStore';

const TOOLS = [
  {
    id: 'navigate',
    name: 'Navigate',
    icon: Move3d,
    shortcut: 'Esc',
    description: 'Rotate, pan, and zoom'
  },
  {
    id: 'measure-distance',
    name: 'Distance',
    icon: Ruler,
    shortcut: 'M',
    description: 'Measure distance between two points'
  },
  {
    id: 'measure-angle',
    name: 'Angle',
    icon: RotateCcw,
    shortcut: 'A',
    description: 'Measure angle between three points'
  },
  {
    id: 'cross-section',
    name: 'Cross Section',
    icon: Scissors,
    shortcut: 'C',
    description: 'Slice and view cross-sections'
  },
  {
    id: 'annotate',
    name: 'Annotate',
    icon: MessageSquare,
    shortcut: 'N',
    description: 'Add markers and notes'
  },
  {
    id: 'compare',
    name: 'Compare',
    icon: GitCompare,
    shortcut: 'K',
    description: 'Compare with another scan'
  }
];

export const Toolbar = ({ activeTool, onToolChange }) => {
  const {
    showGrid,
    toggleGrid,
    materialSettings,
    toggleWireframe,
    background,
    toggleTheme,
    resetView,
    sidebarVisible,
    toggleSidebar
  } = useIOSViewerStore();

  return (
    <TooltipProvider>
      <div className="flex items-center justify-between">
        {/* Tool Selection */}
        <div className="flex items-center gap-1">
          {TOOLS.map((tool, index) => (
            <React.Fragment key={tool.id}>
              {index === 3 && <Separator orientation="vertical" className="h-6 mx-1" />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={activeTool === tool.id ? 'default' : 'ghost'}
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => onToolChange(tool.id)}
                  >
                    <tool.icon className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="flex flex-col items-center">
                  <span className="font-medium">{tool.name}</span>
                  <span className="text-xs text-muted-foreground">{tool.description}</span>
                  <span className="text-xs text-muted-foreground mt-1">Shortcut: {tool.shortcut}</span>
                </TooltipContent>
              </Tooltip>
            </React.Fragment>
          ))}
        </div>

        <Separator orientation="vertical" className="h-6" />

        {/* View Controls */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showGrid ? 'default' : 'ghost'}
                size="icon"
                className="h-9 w-9"
                onClick={toggleGrid}
              >
                <Grid3X3 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle Grid</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={materialSettings.wireframe ? 'default' : 'ghost'}
                size="icon"
                className="h-9 w-9"
                onClick={toggleWireframe}
              >
                <Box className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Wireframe Mode</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={toggleTheme}
              >
                {background.isDark ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {background.isDark ? 'Light Mode' : 'Dark Mode'}
            </TooltipContent>
          </Tooltip>

          <Separator orientation="vertical" className="h-6 mx-1" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={resetView}
              >
                <Target className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reset View (R)</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default Toolbar;
