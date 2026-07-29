#ifndef VOUCHER_MANAGER_H
#define VOUCHER_MANAGER_H

#include <string>
#include <vector>
#include "transaction.h"

struct unusedVoucher
{
  std::string voucherId;
  int amount;

  unusedVoucher(const std::string &id = "", int amt = 0) : voucherId(id), amount(amt) {}
};

void enqueueVoucher(std::vector<unusedVoucher> &vec, const unusedVoucher &value);
unusedVoucher dequeueVoucher(std::vector<unusedVoucher> &vec);
int getTotalVoucherAmount(const std::vector<unusedVoucher> &vouchers);
std::vector<unusedVoucher> getAvailableVoucher(const std::vector<unusedVoucher> &availableVouchers, double targetAmount);

#endif // VOUCHER_MANAGER_H
