import React, { useCallback,useRef, useState } from 'react';

import { cn } from '@/shared/utils/utils';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  children: React.ReactNode;
  content?: React.ReactNode;
  position?: TooltipPosition;
  className?: string;
  delay?: number;
}

const Tooltip = ({
  children,
  content,
  position = 'top',
  className = '',
  delay = 500
}: TooltipProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
    }, delay);
  }, [delay]);

  const handleMouseLeave = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  const getPositionClasses = () => {
    switch (position) {
      case 'top':
        return 'bottom-full left-1/2 transform -translate-x-1/2 mb-2';
      case 'bottom':
        return 'top-full left-1/2 transform -translate-x-1/2 mt-2';
      case 'left':
        return 'right-full top-1/2 transform -translate-y-1/2 mr-2';
      case 'right':
        return 'left-full top-1/2 transform -translate-y-1/2 ml-2';
      default:
        return 'bottom-full left-1/2 transform -translate-x-1/2 mb-2';
    }
  };

  const getArrowClasses = () => {
    switch (position) {
      case 'top':
        return 'top-full left-1/2 transform -translate-x-1/2';
      case 'bottom':
        return 'bottom-full left-1/2 transform -translate-x-1/2';
      case 'left':
        return 'left-full top-1/2 transform -translate-y-1/2';
      case 'right':
        return 'right-full top-1/2 transform -translate-y-1/2';
      default:
        return 'top-full left-1/2 transform -translate-x-1/2';
    }
  };

  const getArrowStyle = (): React.CSSProperties => {
    const color = 'hsl(var(--popover))';
    switch (position) {
      case 'top':
        return { borderTopColor: color };
      case 'bottom':
        return { borderBottomColor: color };
      case 'left':
        return { borderLeftColor: color };
      case 'right':
        return { borderRightColor: color };
      default:
        return { borderTopColor: color };
    }
  };

  React.useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    []
  );

  if (!content) {
    return <>{children}</>;
  }

  return (
    <div 
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      
      {isVisible ? <div className={cn(
          'absolute z-50 px-2 py-1 text-xs font-medium text-popover-foreground bg-popover border border-border/70 rounded shadow-lg whitespace-nowrap pointer-events-none',
          'animate-in fade-in-0 zoom-in-95 duration-200',
          getPositionClasses(),
          className
        )}>
          {content}
          
          {/* Arrow */}
          <div
            className={cn(
              'absolute w-0 h-0 border-4 border-transparent',
              getArrowClasses()
            )}
            style={getArrowStyle()}
          />
        </div> : null}
    </div>
  );
};

export default Tooltip;
