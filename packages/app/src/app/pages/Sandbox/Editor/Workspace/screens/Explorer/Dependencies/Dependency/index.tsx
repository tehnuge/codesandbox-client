import Tooltip, {
  SingletonTooltip,
} from '@codesandbox/common/es/components/Tooltip';
import { formatVersion } from '@codesandbox/common/es/utils/ci';
import {
  Button,
  Link,
  ListAction,
  Select,
  SidebarRow,
  Stack,
  Text,
} from '@codesandbox/components';
import css from '@styled-system/css';
import algoliasearch from 'algoliasearch/lite';
import compareVersions from 'compare-versions';
import React, { useEffect, useState } from 'react';
import {
  MdClear,
  MdKeyboardArrowDown,
  MdKeyboardArrowUp,
  MdRefresh,
} from 'react-icons/md';

import { BundleSizes } from './BundleSizes';

interface Props {
  dependencies: { [dep: string]: string };
  dependency: string;
  onRemove: (dep: string) => void;
  onRefresh: (dep: string, version?: string) => void;
}

const client = algoliasearch('OFCNCOG2CU', '00383ecd8441ead30b1b0ff981c426f5');
const index = client.initIndex('npm-search');

export const Dependency = ({
  dependencies,
  dependency,
  onRemove,
  onRefresh,
}: Props) => {
  const [version, setVersion] = useState(null);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState([]);

  const setVersionsForLatestPkg = (pkg: string) => {
    fetch(`/api/v1/dependencies/${pkg}`)
      .then(response => response.json())
      .then(data => setVersion(data.data.version))
      .catch(err => {
        if (process.env.NODE_ENV === 'development') {
          console.error(err); // eslint-disable-line no-console
        }
      });
  };

  useEffect(() => {
    // @ts-ignore
    index.getObject(dependency, ['versions']).then(({ versions: results }) => {
      const orderedVersions = Object.keys(results).sort((a, b) => {
        try {
          return compareVersions(b, a);
        } catch (e) {
          return 0;
        }
      });
      setVersions(orderedVersions);
    });

    try {
      const versionRegex = /^\d{1,3}\.\d{1,3}.\d{1,3}$/;
      const propVersion = dependencies[dependency];
      if (!versionRegex.test(propVersion)) {
        setVersionsForLatestPkg(`${dependency}@${propVersion}`);
      }
    } catch (e) {
      console.error(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRemove = e => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    onRemove(dependency);
  };

  const handleRefresh = e => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    onRefresh(dependency);
  };

  if (typeof dependencies[dependency] !== 'string') {
    return null;
  }

  return (
    <>
      <ListAction
        justify="space-between"
        align="center"
        css={css({
          position: 'relative',
          '.actions': {
            backgroundColor: 'sideBar.background',
            display: 'none',
          },
          ':hover .actions': {
            backgroundColor: 'list.hoverBackground',
            display: 'flex',
          },
        })}
      >
        <Link
          href={`/examples/package/${dependency}`}
          target="_blank"
          title={dependency}
          maxWidth="60%"
          css={{
            position: 'absolute',
            zIndex: 2,
            maxWidth: '60%',
          }}
        >
          {dependency}
        </Link>

        <Stack
          align="center"
          justify="flex-end"
          css={css({
            position: 'absolute',
            right: 2,
            flexGrow: 0,
            flexShrink: 1,
            width: '100%',
          })}
        >
          <Text variant="muted" maxWidth="30%">
            {formatVersion(dependencies[dependency])}{' '}
            {version && <span>({formatVersion(version)})</span>}
          </Text>
        </Stack>

        <Stack
          className="actions"
          align="center"
          justify="flex-end"
          css={css({
            position: 'absolute',
            right: 0,
            width: 'auto',
            zIndex: 2, // overlay on dependency name
            paddingLeft: 1,
          })}
        >
          <Select
            css={{ width: '80px' }}
            value={versions.find(v => v === dependencies[dependency])}
            onChange={e => onRefresh(dependency, e.target.value)}
          >
            {versions.map(a => (
              <option key={a}>{a}</option>
            ))}
          </Select>

          <SingletonTooltip>
            {singleton => (
              <>
                <Tooltip
                  content={open ? 'Hide sizes' : 'Show sizes'}
                  style={{ outline: 'none' }}
                  singleton={singleton}
                >
                  <Button
                    variant="link"
                    onClick={() => setOpen(!open)}
                    css={css({ minWidth: 5 })}
                  >
                    {open ? <MdKeyboardArrowUp /> : <MdKeyboardArrowDown />}
                  </Button>
                </Tooltip>
                <Tooltip
                  content="Update to latest"
                  style={{ outline: 'none' }}
                  singleton={singleton}
                >
                  <Button
                    variant="link"
                    onClick={handleRefresh}
                    css={css({ minWidth: 5 })}
                  >
                    <MdRefresh />
                  </Button>
                </Tooltip>
                <Tooltip
                  content="Remove"
                  style={{ outline: 'none' }}
                  singleton={singleton}
                >
                  <Button
                    variant="link"
                    onClick={handleRemove}
                    css={css({ minWidth: 5 })}
                  >
                    <MdClear />
                  </Button>
                </Tooltip>
              </>
            )}
          </SingletonTooltip>
        </Stack>
      </ListAction>
      {open ? (
        <SidebarRow marginX={2}>
          <BundleSizes
            dependency={dependency}
            version={dependencies[dependency]}
          />
        </SidebarRow>
      ) : null}
    </>
  );
};
