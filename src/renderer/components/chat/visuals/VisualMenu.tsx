import { useState } from 'react'
import { DotsIcon } from '../../ui/chip'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/menu'

export interface VisualMenuItem {
  label: string
  hint: string
  onSelect: () => void
}

/** The dots chip at the end of a visual's header: the actions that do not fit in the row. */
export function VisualMenu({ items, className }: { items: VisualMenuItem[]; className: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button type="button" aria-label="More" title="More" className={`${className} inline-flex items-center`}>
          <DotsIcon />
        </button>
      </MenuTrigger>
      <MenuContent aria-label="More">
        {items.map((item) => (
          <MenuItem
            key={item.label}
            hint={item.hint}
            // The hint sits at the right edge, as a column.
            className="[&>span]:flex-1 [&>span>span]:ml-auto [&>span>span]:pl-[16px]"
            onClick={() => {
              setOpen(false)
              item.onSelect()
            }}
          >
            {item.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
