import { Link, useRouterState } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { UnavailableState } from '~/components/ui/unavailable-state';

/**
 * An address with no page, in the layout every unavailable page uses (#131).
 * The router's default was the bare text "Not Found", with no heading,
 * explanation or way back.
 */
export function NotFoundPage() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  // The router marks a link active, with aria-current="page", when the address
  // starts with its target: / for every address. Only an exact match is this
  // page, and here none ever is (#273).
  const exact = { exact: true };
  return (
    <UnavailableState
      title="Page not found"
      actions={
        <Button asChild>
          <Link to="/" activeOptions={exact}>
            New chat
          </Link>
        </Button>
      }
    >
      {`There is no page at ${path}. Check the address, or start a new chat.`}
    </UnavailableState>
  );
}
