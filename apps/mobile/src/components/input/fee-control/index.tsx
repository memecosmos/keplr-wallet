import React, {FunctionComponent, useLayoutEffect, useState} from 'react';
import {
  IFeeConfig,
  IGasConfig,
  IGasSimulator,
  InsufficientFeeError,
  ISenderConfig,
} from '@keplr-wallet/hooks';
import {observer} from 'mobx-react-lite';
import {FormattedMessage, useIntl} from 'react-intl';
import {useStore} from '../../../stores';
import {autorun} from 'mobx';
import {CoinPretty, Dec, PricePretty} from '@keplr-wallet/unit';
import {Columns} from '../../column';
import {Box} from '../../box';
import {Text} from 'react-native';
import {useStyle} from '../../../styles';
import {Gutter} from '../../gutter';
import {IconButton} from '../../icon-button';
import {AdjustmentsHorizontalIcon} from '../../icon/adjustments-horizontal';
import {TransactionFeeModal} from './transaction-fee-modal';
import {GuideBox} from '../../guide-box';
import {UIConfigStore} from '../../../stores/ui-config';
import {IChainStore, IQueriesStore} from '@keplr-wallet/stores';
import {SVGLoadingIcon} from '../../spinner';
import {InformationModal} from '../../modal/infoModal';
import {InformationOutlinedIcon} from '../../icon/information-outlined';

// 기본적으로 `FeeControl` 안에 있는 로직이였지만 `FeeControl` 말고도 다른 UI를 가진 똑같은 기능의 component가
// 여러개 생기게 되면서 공통적으로 사용하기 위해서 custom hook으로 분리함
export const useFeeOptionSelectionOnInit = (
  uiConfigStore: UIConfigStore,
  feeConfig: IFeeConfig,
  disableAutomaticFeeSet: boolean | undefined,
) => {
  useLayoutEffect(() => {
    if (disableAutomaticFeeSet) {
      return;
    }

    if (
      feeConfig.fees.length === 0 &&
      feeConfig.selectableFeeCurrencies.length > 0
    ) {
      if (uiConfigStore.rememberLastFeeOption && uiConfigStore.lastFeeOption) {
        feeConfig.setFee({
          type: uiConfigStore.lastFeeOption,
          currency: feeConfig.selectableFeeCurrencies[0],
        });
      } else {
        feeConfig.setFee({
          type: 'average',
          currency: feeConfig.selectableFeeCurrencies[0],
        });
      }
    }
  }, [
    disableAutomaticFeeSet,
    feeConfig,
    feeConfig.fees,
    feeConfig.selectableFeeCurrencies,
    uiConfigStore.lastFeeOption,
    uiConfigStore.rememberLastFeeOption,
  ]);
};

export const useAutoFeeCurrencySelectionOnInit = (
  chainStore: IChainStore,
  queriesStore: IQueriesStore,
  senderConfig: ISenderConfig,
  feeConfig: IFeeConfig,
  disableAutomaticFeeSet: boolean | undefined,
) => {
  useLayoutEffect(() => {
    if (disableAutomaticFeeSet) {
      return;
    }

    // Require to invoke effect whenever chain is changed,
    // even though it is not used in logic.
    noop(feeConfig.chainId);

    // Try to find other fee currency if the account doesn't have enough fee to pay.
    // This logic can be slightly complex, so use mobx's `autorun`.
    // This part fairly different with the approach of react's hook.
    let skip = false;
    // Try until 500ms to avoid the confusion to user.
    const timeoutId = setTimeout(() => {
      skip = true;
    }, 500);

    const disposer = autorun(() => {
      if (
        !skip &&
        feeConfig.type !== 'manual' &&
        feeConfig.selectableFeeCurrencies.length > 1 &&
        feeConfig.fees.length > 0
      ) {
        const queryBalances = queriesStore
          .get(feeConfig.chainId)
          .queryBalances.getQueryBech32Address(senderConfig.sender);

        const currentFeeCurrency = feeConfig.fees[0].currency;
        const currentFeeCurrencyBal =
          queryBalances.getBalanceFromCurrency(currentFeeCurrency);

        const currentFee = feeConfig.getFeeTypePrettyForFeeCurrency(
          currentFeeCurrency,
          feeConfig.type,
        );
        if (currentFeeCurrencyBal.toDec().lt(currentFee.toDec())) {
          const isOsmosis =
            chainStore.hasChain(feeConfig.chainId) &&
            chainStore.getChain(feeConfig.chainId).hasFeature('osmosis-txfees');

          // Not enough balances for fee.
          // Try to find other fee currency to send.
          for (const feeCurrency of feeConfig.selectableFeeCurrencies) {
            const feeCurrencyBal =
              queryBalances.getBalanceFromCurrency(feeCurrency);
            const fee = feeConfig.getFeeTypePrettyForFeeCurrency(
              feeCurrency,
              feeConfig.type,
            );

            // Osmosis의 경우는 fee의 spot price를 알아야 fee를 계산할 수 있다.
            // 그런데 문제는 이게 쿼리가 필요하기 때문에 비동기적이라 response를 기다려야한다.
            // 어쨋든 스왑에 의해서만 fee 계산이 이루어지기 때문에 fee로 Osmo가 0이였다면 이 로직까지 왔을리가 없고
            // 어떤 갯수의 Osmo던지 스왑 이후에 fee가 0이 될수는 없기 때문에
            // 0라면 단순히 response 준비가 안된것이라 확신할 수 있다.
            if (isOsmosis && fee.toDec().lte(new Dec(0))) {
              continue;
            }

            if (feeCurrencyBal.toDec().gte(fee.toDec())) {
              feeConfig.setFee({
                type: feeConfig.type,
                currency: feeCurrency,
              });
              const uiProperties = feeConfig.uiProperties;
              skip =
                !uiProperties.loadingState &&
                uiProperties.error == null &&
                uiProperties.warning == null;
              return;
            }
          }
        }
      }
    });

    return () => {
      clearTimeout(timeoutId);
      skip = true;
      disposer();
    };
  }, [
    chainStore,
    disableAutomaticFeeSet,
    feeConfig,
    feeConfig.chainId,
    queriesStore,
    senderConfig.sender,
  ]);
};

export const FeeControl: FunctionComponent<{
  senderConfig: ISenderConfig;
  feeConfig: IFeeConfig;
  gasConfig: IGasConfig;
  gasSimulator?: IGasSimulator;

  disableAutomaticFeeSet?: boolean;
}> = observer(
  ({
    senderConfig,
    feeConfig,
    gasConfig,
    gasSimulator,
    disableAutomaticFeeSet,
  }) => {
    const {queriesStore, priceStore, chainStore, uiConfigStore} = useStore();
    const intl = useIntl();
    const style = useStyle();

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
    const hasError =
      feeConfig.uiProperties.error || feeConfig.uiProperties.warning;

    useFeeOptionSelectionOnInit(
      uiConfigStore,
      feeConfig,
      disableAutomaticFeeSet,
    );

    useAutoFeeCurrencySelectionOnInit(
      chainStore,
      queriesStore,
      senderConfig,
      feeConfig,
      disableAutomaticFeeSet,
    );

    return (
      <Box
        style={style.flatten(['width-full'])}
        alignX="center"
        paddingTop={16}
        paddingBottom={8}>
        <Columns sum={1} alignY="center">
          {disableAutomaticFeeSet ? (
            <React.Fragment>
              <IconButton
                icon={
                  <InformationOutlinedIcon
                    size={20}
                    color={style.get('color-gray-300').color}
                  />
                }
                style={style.flatten(['border-radius-64'])}
                containerStyle={style.flatten([
                  'width-32',
                  'height-32',
                  'border-radius-16',
                ])}
                onPress={() => setIsInfoModalOpen(true)}
              />

              <Gutter size={4} />
            </React.Fragment>
          ) : null}

          <Text
            style={style.flatten([
              'body2',
              hasError ? 'color-yellow-400' : 'color-white',
            ])}>
            <FormattedMessage
              id="components.input.fee-control.fee"
              values={{
                assets: (() => {
                  if (feeConfig.fees.length > 0) {
                    return feeConfig.fees;
                  }
                  const chainInfo = chainStore.getChain(feeConfig.chainId);

                  return [
                    new CoinPretty(
                      chainInfo.stakeCurrency || chainInfo.currencies[0],
                      new Dec(0),
                    ),
                  ];
                })()
                  .map(fee =>
                    fee
                      .maxDecimals(6)
                      .inequalitySymbol(true)
                      .trim(true)
                      .shrink(true)
                      .hideIBCMetadata(true)
                      .toString(),
                  )
                  .join('+'),
              }}
            />
          </Text>

          <Gutter size={4} />

          <Text style={style.flatten(['body2', 'color-gray-300'])}>
            {(() => {
              let total: PricePretty | undefined;
              let hasUnknown = false;
              for (const fee of feeConfig.fees) {
                if (!fee.currency.coinGeckoId) {
                  hasUnknown = true;
                  break;
                } else {
                  const price = priceStore.calculatePrice(fee);
                  if (price) {
                    if (!total) {
                      total = price;
                    } else {
                      total = total.add(price);
                    }
                  }
                }
              }

              if (hasUnknown || !total) {
                return '-';
              }
              return `(${total.toString()})`;
            })()}
          </Text>

          {!disableAutomaticFeeSet && uiConfigStore.rememberLastFeeOption ? (
            <React.Fragment>
              <Gutter size={8} />

              <Box
                width={6}
                height={6}
                borderRadius={999}
                backgroundColor={style.get('color-blue-400').color}
              />
            </React.Fragment>
          ) : null}

          <Gutter size={8} />

          <IconButton
            icon={
              <AdjustmentsHorizontalIcon
                size={20}
                color={
                  style.get(hasError ? 'color-yellow-400' : 'color-white').color
                }
              />
            }
            style={style.flatten(['border-radius-64'])}
            containerStyle={style.flatten([
              'width-32',
              'height-32',
              'border-radius-16',
              'background-color-gray-500',
            ])}
            onPress={() => setIsModalOpen(true)}
          />

          {feeConfig.uiProperties.loadingState ||
          gasSimulator?.uiProperties.loadingState ? (
            <React.Fragment>
              <Gutter size={8} />

              <Box width={24} height={24} alignX="center" alignY="center">
                <SVGLoadingIcon color={'white'} size={20} />
              </Box>
            </React.Fragment>
          ) : null}
        </Columns>

        {hasError ? (
          <Box width="100%">
            <Gutter size={16} />

            <GuideBox
              hideInformationIcon={true}
              color="warning"
              title={
                (() => {
                  if (feeConfig.uiProperties.error) {
                    if (
                      feeConfig.uiProperties.error instanceof
                      InsufficientFeeError
                    ) {
                      return intl.formatMessage({
                        id: 'components.input.fee-control.error.insufficient-fee',
                      });
                    }

                    return (
                      feeConfig.uiProperties.error.message ||
                      feeConfig.uiProperties.error.toString()
                    );
                  }

                  if (feeConfig.uiProperties.warning) {
                    return (
                      feeConfig.uiProperties.warning.message ||
                      feeConfig.uiProperties.warning.toString()
                    );
                  }

                  if (gasConfig.uiProperties.error) {
                    return (
                      gasConfig.uiProperties.error.message ||
                      gasConfig.uiProperties.error.toString()
                    );
                  }

                  if (gasConfig.uiProperties.warning) {
                    return (
                      gasConfig.uiProperties.warning.message ||
                      gasConfig.uiProperties.warning.toString()
                    );
                  }
                })() ?? ''
              }
              titleStyle={{textAlign: 'center'}}
            />
          </Box>
        ) : null}

        <TransactionFeeModal
          isOpen={isModalOpen}
          setIsOpen={setIsModalOpen}
          senderConfig={senderConfig}
          feeConfig={feeConfig}
          gasConfig={gasConfig}
          gasSimulator={gasSimulator}
          disableAutomaticFeeSet={disableAutomaticFeeSet}
        />

        <InformationModal
          isOpen={isInfoModalOpen}
          setIsOpen={setIsInfoModalOpen}
          title={intl.formatMessage({
            id: 'components.input.fee-control.tooltip.external-fee-set',
          })}
          paragraph={intl.formatMessage({
            id: 'components.input.fee-control.modal.guide.external-fee-set',
          })}
        />
      </Box>
    );
  },
);

const noop = (..._args: any[]) => {
  // noop
};
