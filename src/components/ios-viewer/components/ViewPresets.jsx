/**
 * IOS Viewer Pro - View Presets Component
 * Quick access to dental-specific viewing angles
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Eye,
  ChevronDown,
  Box,
  Grid3X3,
  Target,
  Smile,
  CircleDot,
  Square,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  ChevronDown as ChevronDownIcon,
  Bookmark
} from 'lucide-react';
import { useIOSViewerStore, DENTAL_VIEW_PRESETS } from '../store/iosViewerStore';

const PRESET_ICONS = {
  'front': Eye,
  'back': Eye,
  'top': ArrowUp,
  'bottom': ArrowDown,
  'left': ArrowLeft,
  'right': ArrowRight,
  'buccal-right': ChevronUp,
  'buccal-left': ChevronUp,
  'lingual-right': ChevronDownIcon,
  'lingual-left': ChevronDownIcon,
  'smile-line': Smile,
  'occlusal-upper': CircleDot,
  'occlusal-lower': CircleDot,
};

export const ViewPresets = ({ currentPreset, onSelect }) => {
  const { viewPreset } = useIOSViewerStore();

  // Group presets by category
  const categories = [
    {
      name: 'Standard',
      presets: DENTAL_VIEW_PRESETS.filter(p =>
        ['front', 'back', 'top', 'bottom', 'left', 'right'].includes(p.id)
      )
    },
    {
      name: 'Dental',
      presets: DENTAL_VIEW_PRESETS.filter(p =>
        ['buccal-right', 'buccal-left', 'lingual-right', 'lingual-left', 'smile-line'].includes(p.id)
      )
    },
    {
      name: 'Occlusal',
      presets: DENTAL_VIEW_PRESETS.filter(p =>
        ['occlusal-upper', 'occlusal-lower'].includes(p.id)
      )
    }
  ];

  return (
    <TooltipProvider>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="gap-2">
            <Target className="h-4 w-4" />
            <span className="hidden sm:inline">{currentPreset?.name || 'View'}</span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-48">
          {categories.map((category, categoryIndex) => (
            <React.Fragment key={category.name}>
              {categoryIndex > 0 && <DropdownMenuSeparator />}
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                {category.name}
              </div>
              {category.presets.map((preset) => {
                const Icon = PRESET_ICONS[preset.id] || Eye;
                return (
                  <DropdownMenuItem
                    key={preset.id}
                    className="gap-2 cursor-pointer"
                    onClick={() => onSelect(preset)}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{preset.name}</span>
                    {currentPreset?.id === preset.id && (
                      <div className="ml-auto w-2 h-2 rounded-full bg-primary" />
                    )}
                  </DropdownMenuItem>
                );
              })}
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
};

export default ViewPresets;
